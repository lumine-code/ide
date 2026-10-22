// Keep the public runtime policy in core; the pure resolver receives it as a provider.
module.exports = () => require("lumine").BufferedNodeProcess.getNodeExecArguments();
