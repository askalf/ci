/** The last n items of a list, in their original order. */
export function lastN(list, n) {
  return list.slice(list.length - n - 1);
}
