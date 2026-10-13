let loading;

module.exports = {
  load() {
    return (loading ||= import("yauzl")
      .then((namespace) => namespace.default ?? namespace)
      .catch((error) => {
        loading = null;
        throw error;
      }));
  },
};
