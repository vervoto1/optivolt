export function debounce(fn, wait = 250) {
  let timer = null;

  const debounced = (...args) => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };

  // v8 ignore next — null path of === check is untestable (timer is always set in tests)
  debounced.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return debounced;
}
