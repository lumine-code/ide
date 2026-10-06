// Acquire the current package generation without starting a language server.
module.exports = () => {
  const pack = lumine.packages.loadPackage("ide-basedpyright");
  pack.requireMainModule();
  let adapter;
  const registration = pack.mainModule.consumeIde({
    registerAdapter(value) {
      adapter = value;
      return { dispose() {} };
    },
  });
  registration.dispose();
  return adapter;
};
