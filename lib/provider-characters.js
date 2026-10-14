// Capability metadata is read during service registration, before any provider
// performs a request. Keep it independent of the completion and signature UI.
module.exports = function providerCharacters(manager, method, key) {
  const characters = new Set();
  for (const session of manager?.allSessions() || []) {
    if (session.state !== "running") continue;
    for (const character of session.capabilityOptions(method)?.[key] || [])
      characters.add(character);
  }
  return characters;
};
