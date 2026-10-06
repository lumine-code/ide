const { configurationContext, readSettings } = require("./workspace-configuration");

// A minute of healthy uptime begins a new automatic restart allowance.
const HEALTHY_UPTIME_MS = 60000;
const IDLE_SHUTDOWN_MS = 1000;

// One logical server owns every process generation, transition and retry.
// Its host supplies routing, project policy and presentation, never transitions.
module.exports = class SessionController {
  constructor(adapter, rootPath, host) {
    this.adapter = adapter;
    this.rootPath = rootPath;
    this.host = host;
    this.folders = new Set([rootPath]);
    this.routeRoots = new Set();
    this.children = new Set();
    this.physicalScopes = new WeakMap();
    this.generations = new WeakMap();
    this.stops = new WeakMap();
    this.stoppedChildren = new WeakSet();
    this.reportedStopErrors = new WeakSet();
    this.blockedChildren = new Set();
    this.session = null;
    this.ensurePromise = null;
    this.reattachAfterEnsure = false;
    this.shutdownPromise = null;
    this.restartPromise = null;
    this.restartSources = new Set();
    this.requestedGeneration = 0;
    this.completedGeneration = 0;
    this.revision = 0;
    this.desiredRetry = false;
    this.restartCount = 0;
    this.failureCount = 0;
    this.explicitDemand = false;
    this.hasStarted = false;
    this.startingSession = null;
    this.lastFailedSession = null;
    this.changeWaiters = new Set();
    this.settingsRevision = 0;
    this.settingsPromise = null;
    this.reportedSettingsRevision = null;
    this.retryTimer = null;
    this.retrySource = null;
    this.idleTimer = null;
    this.cancelled = false;
  }
  isActive() {
    return !this.cancelled && this.host.isActive(this);
  }
  get blockedByLiveStop() {
    return this.blockedChildren.values().next().value || null;
  }
  track(session) {
    this.children.add(session);
    this.generations.set(session, this.requestedGeneration);
    this.physicalScopes.set(session, {
      workspace: this.adapter.sessionScope === "workspace",
      roots: new Set(this.folders),
    });
  }
  rememberFolder(rootPath) {
    this.physicalScopes.get(this.session)?.roots.add(rootPath);
  }
  covers(session, rootPath) {
    const scope = this.physicalScopes.get(session);
    return !!scope && (scope.workspace || scope.roots.has(rootPath));
  }
  publish(session) {
    if (!this.isActive()) return false;
    this.degradedObservation = null;
    this.session = session;
    this.startingSession = session;
    this.lastFailedSession = null;
    this.cancelIdle();
    this.hasStarted = true;
    session.settingsRevision ??= this.settingsRevision;
    session.folders = this.folders;
    this.track(session);
    this.host.registerSession(this, session);
    // Publication calls observers synchronously. They may close or supersede
    // this generation before its process has been started.
    if (
      this.isActive() &&
      this.session === session &&
      this.generations.get(session) === this.requestedGeneration
    )
      return true;
    this.withdraw(session);
    return false;
  }
  withdraw(session) {
    if (this.session === session) {
      this.session = null;
      this.degradedObservation = null;
    }
    this.host.withdrawSession(session);
  }
  blockOnChild(session) {
    if (!this.host.physicallyExited(session)) this.blockedChildren.add(session);
  }
  async waitForExit() {
    while (this.isActive() && this.blockedChildren.size) {
      for (const session of [...this.blockedChildren])
        if (this.host.physicallyExited(session)) this.host.didExitProcess(session);
      if (!this.blockedChildren.size) return;
      await this.waitForChange(
        this.requestedGeneration,
        this.revision,
        Promise.all(
          [...this.blockedChildren].map((session) => this.host.waitForSessionExit(session)),
        ),
      );
    }
  }
  exited(session) {
    // Physical exit releases quarantine; the model may still own protocol or
    // document resources until its stop operation has completed.
    if (this.stoppedChildren.has(session)) this.children.delete(session);
    this.physicalScopes.delete(session);
    if (this.blockedChildren.delete(session)) {
      this.wake();
      this.host.scheduleReattachAll();
    }
  }
  stopResult(session) {
    let pending = this.stops.get(session);
    if (!pending) {
      let finish;
      pending = new Promise((resolve) => (finish = resolve));
      this.stops.set(session, pending);
      (async () => {
        let stopError = null;
        try {
          await session.stop();
        } catch (error) {
          stopError = error;
        }
        this.stoppedChildren.add(session);
        if (this.host.physicallyExited(session)) this.children.delete(session);
        this.blockOnChild(session);
        finish(stopError);
      })();
    }
    return pending;
  }
  stopChild(session) {
    return this.stopResult(session).then((error) => {
      if (error && !this.reportedStopErrors.has(session)) {
        this.reportedStopErrors.add(session);
        this.host.stopFailure(session, error);
      }
    });
  }
  shutdown({ strict = false } = {}) {
    if (!this.shutdownPromise) {
      const sessions = [
        ...new Set([this.session, this.startingSession, this.lastFailedSession, ...this.children]),
      ].filter(Boolean);
      this.host.cancelController(this);
      this.shutdownPromise = Promise.all(
        sessions.map(async (session) => ({ session, error: await this.stopResult(session) })),
      );
    }
    return this.shutdownPromise.then((results) => {
      const failed = results.find(({ error }) => error);
      if (strict && failed) throw failed.error;
      if (!strict)
        for (const { session, error } of results)
          if (error && !this.reportedStopErrors.has(session)) {
            this.reportedStopErrors.add(session);
            this.host.stopFailure(session, error);
          }
    });
  }
  documentClosed(session) {
    if (this.idleTimer || this.cancelled || this.session !== session) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.session === session) this.host.stopIfUnreachable(session);
    }, IDLE_SHUTDOWN_MS);
  }
  cancelIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.requestedGeneration++;
    this.cancelRetry();
    this.cancelIdle();
    this.wake();
  }
  settingsChanged() {
    this.settingsRevision++;
    return this.flushSettings();
  }
  async prepareStartup(generation, revision) {
    const activity = this.host.beginStartup(this);
    try {
      return await this.prepareStartupSnapshot(generation, revision);
    } finally {
      activity.dispose();
    }
  }
  async prepareStartupSnapshot(generation, revision) {
    const context = await this.host.prepareContext(this, generation, revision);
    if (context.stale) return { stale: true };
    const { rootPath, rootUri, workspaceFolders, observations, resolutionContext } = context;
    const step = (work) => this.waitForChange(generation, revision, Promise.resolve().then(work));
    const resolved = await step(() => this.adapter.resolveServer(resolutionContext));
    if (resolved.stale) return { stale: true };
    const launch = resolved.value;
    if (!launch)
      return {
        stale: false,
        launch: null,
        rootPath,
        startup: { workspaceFolders, initializationOptions: undefined, settings: {} },
      };
    const initialized = await step(() =>
      this.adapter.getInitializationOptions?.({ rootPath, rootUri }),
    );
    if (initialized.stale) return { stale: true };
    const settingsRevision = this.settingsRevision;
    const configured = await step(() =>
      readSettings(this.adapter, configurationContext(rootPath, launch)),
    );
    if (configured.stale) return { stale: true };
    return {
      stale: false,
      launch,
      rootPath,
      startup: {
        workspaceFolders,
        initializationOptions: initialized.value,
        settings: configured.value,
      },
      settingsRevision,
      observations,
    };
  }
  stateChanged(session) {
    if (
      this.startingSession === session &&
      ["running", "failed", "stopped"].includes(session.state)
    )
      this.startingSession = null;
    if (session.state === "running" && this.session === session) {
      this.flushSettings()?.then(() => {
        if (
          this.session === session &&
          session.state === "running" &&
          (session.settingsRevision || 0) < this.settingsRevision
        )
          this.flushSettings();
      });
    }
  }
  scheduleRetry(session) {
    if (!this.isActive()) return;
    if (this.session !== session && (this.session || this.lastFailedSession !== session)) return;
    if ((this.generations.get(session) ?? this.requestedGeneration) !== this.requestedGeneration)
      return;
    if (this.retryTimer) {
      if (this.retrySource === session) return;
      this.cancelRetry();
    }
    if (session.runningSince != null && Date.now() - session.runningSince >= HEALTHY_UPTIME_MS) {
      session.failureCount = 0;
      session.gaveUp = false;
    }
    if (session.failureCount >= this.host.restartLimit()) {
      if (!session.gaveUp) {
        session.gaveUp = true;
        this.host.exhausted(session);
      }
      return;
    }
    const delay = Math.min(1000 * 2 ** session.failureCount++, 30000);
    if (!(this.restartPromise && !this.desiredRetry)) this.failureCount = session.failureCount;
    this.retrySource = session;
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      this.retrySource = null;
      if (!this.isActive()) return;
      try {
        await this.restart({ retry: true, source: session });
      } catch (error) {
        this.host.log(session, error.stack || error);
        this.scheduleRetry(this.lastFailedSession || this.session || session);
      }
    }, delay);
  }
  cancelRetry(session) {
    if (session && this.retrySource !== session) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retrySource = null;
  }
  ensure({ isCurrent = () => true } = {}) {
    if (this.restartPromise) return this.restartPromise;
    if (this.ensurePromise) return this.ensurePromise;
    const pending = this.drainEnsure(isCurrent);
    this.ensurePromise = pending;
    const finish = () => {
      if (this.ensurePromise === pending) {
        this.ensurePromise = null;
        if (this.reattachAfterEnsure) {
          this.reattachAfterEnsure = false;
          this.host.scheduleReattachAll();
        }
      }
    };
    pending.then(finish, finish);
    return pending;
  }
  async drainEnsure(isCurrent) {
    while (this.isActive()) {
      if (this.blockedByLiveStop) {
        await this.waitForExit();
        continue;
      }
      if (this.restartPromise) return this.restartPromise;
      const generation = this.requestedGeneration;
      const revision = this.revision;
      let prepared;
      try {
        prepared = await this.prepareStartup(generation, revision);
      } catch (error) {
        if (
          this.isActive() &&
          this.requestedGeneration === generation &&
          this.revision === revision &&
          isCurrent()
        )
          this.host.reportStartFailure(this.adapter, this.rootPath, error);
        throw error;
      }
      if (prepared.stale) continue;
      if (
        !this.isActive() ||
        this.requestedGeneration !== generation ||
        this.revision !== revision ||
        !isCurrent()
      ) {
        this.reattachAfterEnsure = true;
        return null;
      }
      if (!prepared.launch || !this.host.controllerHasDemand(this)) {
        if (!this.host.controllerHasDemand(this)) this.host.retireController(this);
        return null;
      }
      if (this.session) return this.session;
      const session = this.host.createSession(this, prepared);
      session.settingsRevision = prepared.settingsRevision;
      if (!this.publish(session)) {
        await this.stopChild(session);
        if (this.isActive()) continue;
        return null;
      }
      if (!isCurrent() || !this.host.controllerHasDemand(this)) {
        this.withdraw(session);
        await this.stopChild(session);
        if (!this.host.controllerHasDemand(this)) this.host.retireController(this);
        this.reattachAfterEnsure = true;
        return null;
      }
      session.ready = Promise.resolve(session.start());
      session.ready.catch(() => {});
      this.host.recoverDegradedObservation(this, session, prepared.observations);
      return session;
    }
    return null;
  }
  wake() {
    for (const wake of this.changeWaiters) wake();
    this.changeWaiters.clear();
  }
  waitForChange(generation, revision, promise) {
    if (this.requestedGeneration !== generation || this.revision !== revision || !this.isActive())
      return Promise.resolve({ stale: true });
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (result, rejected = false, error) => {
        if (settled) return;
        settled = true;
        this.changeWaiters.delete(changed);
        if (rejected) reject(error);
        else resolve(result);
      };
      const changed = () => finish({ stale: true });
      this.changeWaiters.add(changed);
      Promise.resolve(promise).then(
        (value) => finish({ stale: false, value }),
        (error) => finish(null, true, error),
      );
      if (this.requestedGeneration !== generation || this.revision !== revision || !this.isActive())
        changed();
    });
  }
  structureChanged() {
    if (this.cancelled) return;
    this.revision++;
    this.wake();
    if (this.restartPromise || this.startingSession)
      this.restart({ force: true }).catch((error) =>
        this.host.log({ adapter: this.adapter, rootPath: this.rootPath }, error.stack || error),
      );
  }
  restart({ retry = false, force = false, source } = {}) {
    if (!this.isActive()) return Promise.resolve(null);
    // A crash observed while a manual or configuration restart is already in
    // flight belongs to that operation. It must not turn the final generation
    // back into an automatic retry or carry the old failure count into it.
    if (retry && this.restartPromise && !this.desiredRetry) return this.restartPromise;
    // Retry timers belong to the generation that scheduled them. Once a
    // manual/configuration restart has installed a healthy replacement, an old
    // source is stale and must not be allowed to tear that replacement down.
    if (
      retry &&
      source &&
      this.session !== source &&
      (this.session || this.lastFailedSession !== source)
    )
      return Promise.resolve(this.session);
    if (
      this.restartPromise &&
      !force &&
      source &&
      this.restartSources.has(source) &&
      !(this.desiredRetry && !retry)
    )
      return this.restartPromise;

    if (!retry) {
      this.cancelRetry();
      if (this.session) {
        this.session.failureCount = 0;
        this.session.gaveUp = false;
      }
    } else if (source) {
      this.failureCount = source.failureCount || 0;
      if (this.session !== source)
        this.restartCount = Math.max(this.restartCount, (source.restartCount || 0) + 1);
    }
    this.desiredRetry = retry;
    this.requestedGeneration++;
    this.wake();
    if (this.startingSession?.state === "starting") this.stopChild(this.startingSession);
    if (source) this.restartSources.add(source);
    if (this.restartPromise) return this.restartPromise;

    const pending = this.drainRestart();
    this.restartPromise = pending;
    pending.then(
      () => {
        if (this.restartPromise === pending) {
          this.restartPromise = null;
          this.restartSources.clear();
        }
      },
      () => {
        if (this.restartPromise === pending) {
          this.restartPromise = null;
          this.restartSources.clear();
        }
      },
    );
    return pending;
  }
  async drainRestart() {
    while (this.isActive()) {
      if (this.blockedByLiveStop) {
        await this.waitForExit();
        continue;
      }
      const generation = this.requestedGeneration;
      const revision = this.revision;
      const retry = this.desiredRetry;
      const current = this.session;
      let prepared;
      try {
        // The complete startup input is prepared first. A bad executable,
        // initialization option or initial settings value must not take a
        // healthy old server down merely to discover the new configuration is
        // unusable.
        prepared = await this.prepareStartup(generation, revision);
      } catch (error) {
        if (
          generation !== this.requestedGeneration ||
          revision !== this.revision ||
          !this.isActive()
        )
          continue;
        throw error;
      }
      if (prepared.stale) continue;
      if (!this.isActive()) return null;
      if (generation !== this.requestedGeneration) continue;
      if (revision !== this.revision) continue;
      if (this.session !== current) continue;

      if (current) {
        this.restartCount = (current.restartCount || 0) + 1;
        this.failureCount = retry ? current.failureCount || 0 : 0;
        const stopError = await this.stopResult(current);
        this.withdraw(current);
        if (!this.isActive()) return null;
        const stale = generation !== this.requestedGeneration || revision !== this.revision;
        if (stopError) {
          const exited = this.host.physicallyExited(current);
          if (stopError.exitNotificationTimedOut && exited) {
            this.host.log(
              current,
              `Exit notification timed out; continuing restart after process exit`,
            );
          } else {
            if (stale && exited) continue;
            if (!exited) this.blockOnChild(current);
            throw stopError;
          }
        }
        this.blockOnChild(current);
        if (this.blockedByLiveStop) await this.waitForExit();
        if (!this.isActive()) return null;
        if (stale || generation !== this.requestedGeneration || revision !== this.revision)
          continue;
      }

      if (!prepared.launch) {
        this.host.log(
          current || { adapter: this.adapter, rootPath: this.rootPath },
          `${this.adapter.displayName} is not available; not restarting`,
        );
        this.completedGeneration = generation;
        if (!this.host.controllerHasDemand(this)) this.host.retireController(this);
        if (generation !== this.requestedGeneration) continue;
        return null;
      }

      if (!this.host.controllerHasDemand(this)) {
        this.host.retireController(this);
        return null;
      }

      const replacement = this.host.createSession(this, prepared);
      replacement.settingsRevision = prepared.settingsRevision;
      replacement.restartCount = this.restartCount || 0;
      replacement.failureCount = retry ? this.failureCount || 0 : 0;
      if (!this.publish(replacement)) {
        await this.stopChild(replacement);
        if (this.isActive()) continue;
        return null;
      }
      replacement.ready = Promise.resolve(replacement.start());
      replacement.ready.catch(() => {});
      this.host.recoverDegradedObservation(this, replacement, prepared.observations);
      try {
        const started = await this.waitForChange(generation, revision, replacement.ready);
        if (started.stale) {
          if (this.startingSession === replacement) this.startingSession = null;
          this.withdraw(replacement);
          await this.stopChild(replacement);
          if (this.isActive()) continue;
          return null;
        }
      } catch (error) {
        // A start error may leave a spawned process behind. Cleanup is
        // unconditional; only the decision to retry or surface the error
        // depends on whether this generation is still current.
        this.lastFailedSession = replacement;
        if (this.startingSession === replacement) this.startingSession = null;
        this.withdraw(replacement);
        await this.stopChild(replacement);
        if (
          !this.isActive() ||
          generation !== this.requestedGeneration ||
          revision !== this.revision
        )
          continue;
        throw error;
      }
      if (this.startingSession === replacement) this.startingSession = null;
      this.lastFailedSession = null;
      if (!this.isActive()) {
        this.withdraw(replacement);
        await this.stopChild(replacement);
        return null;
      }
      if (generation !== this.requestedGeneration) {
        this.withdraw(replacement);
        await this.stopChild(replacement);
        continue;
      }
      if (revision !== this.revision) {
        this.withdraw(replacement);
        await this.stopChild(replacement);
        continue;
      }

      this.host.splitUnsupportedFolders(this, replacement);
      await this.host.reattachAll();
      if (generation !== this.requestedGeneration || revision !== this.revision) continue;
      this.completedGeneration = generation;
      return replacement;
    }
    return null;
  }
  flushSettings() {
    if (this.settingsPromise) return this.settingsPromise;
    let failedRevision = null;
    const pending = (async () => {
      while (this.isActive()) {
        const session = this.session;
        if (!session || session.state !== "running") return;
        const revision = this.settingsRevision;
        if ((session.settingsRevision || 0) >= revision) return;
        try {
          await session.pushSettings();
        } catch (error) {
          if (this.session !== session) continue;
          if (this.reportedSettingsRevision !== revision) {
            this.reportedSettingsRevision = revision;
            this.host.reportSettingsFailure(this, session, revision, error);
          }
          failedRevision = revision;
          return;
        }
        if (!this.isActive()) return;
        if (this.session !== session) continue;
        session.settingsRevision = revision;
        if (this.settingsRevision === revision) return;
      }
    })();
    this.settingsPromise = pending;
    const complete = (successful) => {
      if (this.settingsPromise !== pending) return;
      this.settingsPromise = null;
      const session = this.session;
      if (
        successful &&
        (failedRevision == null || this.settingsRevision !== failedRevision) &&
        this.isActive() &&
        session?.state === "running" &&
        (session.settingsRevision || 0) < this.settingsRevision
      )
        this.flushSettings();
    };
    pending.then(
      () => complete(true),
      () => complete(false),
    );
    return pending;
  }
};
