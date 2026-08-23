// Replace the shared machine/task list without losing where each machine was
// being read. The list is one DOM node whose contents are swapped on a machine
// switch, so the browser cannot preserve these positions on its own.
export function replaceHostList(list, html, previousHostId, nextHostId, positions) {
  if (previousHostId != null) positions.set(previousHostId, list.scrollTop);
  list.innerHTML = html;
  list.scrollTop = positions.get(nextHostId) ?? 0;
}
