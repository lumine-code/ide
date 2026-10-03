// Match busy-signal's service boundary: a title identifies a message within
// each provider, so using one provider for concurrent identical titles fails.
module.exports = () => {
  const providers = new Set();
  const completed = [];
  let created = 0;
  return {
    providers,
    completed,
    get created() {
      return created;
    },
    entries() {
      return [...providers].flatMap((provider) => [...provider.messages.values()]);
    },
    create() {
      created++;
      const provider = {
        messages: new Map(),
        add(title, options) {
          this.messages.set(title, { title, options, started: Date.now() });
        },
        changeTitle(title, oldTitle) {
          const entry = this.messages.get(oldTitle);
          if (!entry) return;
          this.messages.delete(oldTitle);
          entry.title = title;
          this.messages.set(title, entry);
        },
        dispose() {
          completed.push(...this.messages.values());
          this.messages.clear();
          providers.delete(this);
        },
      };
      providers.add(provider);
      return provider;
    },
  };
};
