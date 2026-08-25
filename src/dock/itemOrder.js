/**
 * Reconciles the visible dock order with the ids that can be rendered now.
 *
 * Persisted items keep their relative position from GSettings. Volatile
 * items (for example, an unpinned running app) are appended and never become
 * persisted merely because they are visible.
 */
export function reconcileVisibleOrder(currentOrder, currentIds, storeIds = []) {
  const visible = currentIds instanceof Set ? currentIds : new Set(currentIds);
  const order = currentOrder.filter((id) => visible.has(id));
  const inOrder = new Set(order);
  const newIds = [...visible].filter((id) => !inOrder.has(id));
  if (!newIds.length) return order;

  const storeIndex = new Map(storeIds.map((id, index) => [id, index]));
  const persisted = newIds
    .filter((id) => storeIndex.has(id))
    .sort((a, b) => storeIndex.get(a) - storeIndex.get(b));

  for (const id of persisted) {
    const ownIndex = storeIndex.get(id);
    let after = -1;
    let before = -1;
    order.forEach((other, index) => {
      const otherIndex = storeIndex.get(other);
      if (otherIndex === undefined) return;
      if (otherIndex < ownIndex) after = index;
      else if (before === -1) before = index;
    });

    if (after !== -1) order.splice(after + 1, 0, id);
    else if (before !== -1) order.splice(before, 0, id);
    else order.push(id);
  }

  order.push(...newIds.filter((id) => !storeIndex.has(id)));
  return order;
}

/** Moves an item inside its visual section without crossing section bounds. */
export function moveWithinSection(order, sourceId, targetIndex, sectionOf) {
  const next = [...order];
  const fromIndex = next.indexOf(sourceId);
  if (fromIndex === -1) return next;

  const sourceSection = sectionOf(sourceId);
  next.splice(fromIndex, 1);
  const sectionIds = next.filter((id) => sectionOf(id) === sourceSection);

  let insertionIndex;
  if (!sectionIds.length) insertionIndex = fromIndex;
  else if (targetIndex >= sectionIds.length)
    insertionIndex = next.indexOf(sectionIds.at(-1)) + 1;
  else insertionIndex = next.indexOf(sectionIds[Math.max(0, targetIndex)]);

  next.splice(insertionIndex, 0, sourceId);
  return next;
}

/**
 * Applies the visible order only to persisted slots. Unknown/future ids stay
 * anchored, so an older extension version cannot erase or displace them.
 */
export function mergePersistedOrder(storeIds, visibleOrder) {
  const inStore = new Set(storeIds);
  const reordered = visibleOrder.filter((id) => inStore.has(id));
  if (reordered.length < 2) return [...storeIds];

  const permuted = new Set(reordered);
  let next = 0;
  return storeIds.map((id) =>
    permuted.has(id) ? reordered[next++] : id,
  );
}
