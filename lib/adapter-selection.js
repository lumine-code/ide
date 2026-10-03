// Select only among applicable adapters. Ungrouped servers keep their existing
// order and coexist; preferences never disable a linter beside a type checker.
function selectAdapters(adapters, preferred = []) {
  const order = new Map();
  if (Array.isArray(preferred))
    for (const id of preferred)
      if (typeof id === "string" && !order.has(id)) order.set(id, order.size);
  const winners = new Map();
  const better = (candidate, incumbent) => {
    const candidateRank = order.get(candidate.id) ?? Infinity;
    const incumbentRank = order.get(incumbent.id) ?? Infinity;
    if (candidateRank !== incumbentRank) return candidateRank < incumbentRank;
    const candidatePriority = candidate.selectionPriority ?? 0;
    const incumbentPriority = incumbent.selectionPriority ?? 0;
    if (candidatePriority !== incumbentPriority) return candidatePriority > incumbentPriority;
    return candidate.id < incumbent.id;
  };
  for (const adapter of adapters) {
    if (!adapter.exclusiveGroup) continue;
    const incumbent = winners.get(adapter.exclusiveGroup);
    if (!incumbent || better(adapter, incumbent)) winners.set(adapter.exclusiveGroup, adapter);
  }
  return adapters.filter(
    (adapter) => !adapter.exclusiveGroup || winners.get(adapter.exclusiveGroup) === adapter,
  );
}
function selectionFaults(adapter) {
  const faults = [];
  if (
    adapter.exclusiveGroup !== undefined &&
    (typeof adapter.exclusiveGroup !== "string" || !adapter.exclusiveGroup.trim())
  )
    faults.push("exclusiveGroup");
  if (
    adapter.selectionPriority !== undefined &&
    (typeof adapter.selectionPriority !== "number" || !Number.isFinite(adapter.selectionPriority))
  )
    faults.push("selectionPriority");
  return faults;
}
module.exports = { selectAdapters, selectionFaults };
