describe("IDE list refresh error ownership", () => {
  let list;
  beforeEach(() => jasmine.useRealClock());
  afterEach(async () => {
    await list?.destroy();
  });

  for (const kind of ["sessions", "installations"]) {
    it(`keeps detached ${kind} refresh failures on the list instead of the global rejection handler`, async () => {
      let fail = false;
      const items = ["alpha", "alpine"];
      list = lumine.workspace.buildSelectList({
        items,
        search: {
          scoreModifier: (score) => {
            if (fail) throw new Error("worker failed");
            return score;
          },
        },
      });
      await list.setQuery("al");
      const View = require(
        kind === "sessions" ? "../lib/session-menu-view" : "../lib/managed-servers-view",
      );
      const view =
        kind === "sessions"
          ? {
              destroyed: false,
              serverList: list,
              serverListHost: { isVisible: () => true },
              serverItems: () => items,
            }
          : { destroyed: false, list, listHost: { isVisible: () => true }, items: () => items };
      const unhandled = [];
      const onRejection = (event) => unhandled.push(event.reason?.message);
      window.addEventListener("unhandledrejection", onRejection);
      try {
        fail = true;
        void View.prototype.refresh.call(view);
        await conditionPromise(() => list.getStatus()?.message === "worker failed");
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(unhandled).toEqual([]);
        await expectAsync(View.prototype.refresh.call(view)).toBeRejectedWithError("worker failed");
      } finally {
        window.removeEventListener("unhandledrejection", onRejection);
      }
    });
  }
});
