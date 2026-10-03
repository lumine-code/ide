exports.canExecute = (session, command) => {
  if (!command) return true;
  if (typeof session.canExecuteCommand === "function") return session.canExecuteCommand(command);
  const commands = session.capabilities?.executeCommandProvider?.commands;
  // Older standalone provider facades may not expose command capabilities.
  // Real sessions always expose canExecuteCommand and take the strict branch.
  return !Array.isArray(commands) || commands.includes(command);
};

exports.actionCommand = (action) =>
  typeof action.command === "string" ? action.command : action.command?.command;
