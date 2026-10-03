// Acquire the current package generation without starting a language server.
module.exports = () => {
  const pack = lumine.packages.loadPackage("ide-pyright");
  pack.requireMainModule();
  let adapter;
  const registration = pack.mainModule.consumeIdeClient({
    registerAdapter(value) {
      adapter = value;
      return { dispose() {} };
    },
  });
  registration.dispose();
  return adapter;
};
