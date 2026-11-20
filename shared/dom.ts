// DOM helpers for page plugins: wait for Desktop elements and survive React re-renders.

/** Resolves with the first element matching `selector`, or null after `timeoutMs`. */
export function waitForElement<T extends Element = Element>(
  selector: string,
  { root = document as ParentNode, timeoutMs = 30_000 } = {},
): Promise<T | null> {
  const found = root.querySelector<T>(selector);
  if (found) return Promise.resolve(found);
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const el = root.querySelector<T>(selector);
      if (el) done(el);
    });
    const timer = setTimeout(() => done(null), timeoutMs);
    function done(el: T | null): void {
      observer.disconnect();
      clearTimeout(timer);
      resolve(el);
    }
    observer.observe(root instanceof Document ? root.documentElement : (root as Node), {
      childList: true,
      subtree: true,
    });
  });
}

/**
 * Keeps `node` in the page: `place` inserts it (e.g. `anchor.before(node)`) and is called again
 * whenever a re-render removes it. Returns a stop function that also removes the node.
 */
export function keepInserted(node: Node, place: () => void, root: Node = document.body): () => void {
  const ensure = () => {
    if (!node.isConnected) place();
  };
  const observer = new MutationObserver(ensure);
  observer.observe(root, { childList: true, subtree: true });
  ensure();
  return () => {
    observer.disconnect();
    node.parentNode?.removeChild(node);
  };
}
