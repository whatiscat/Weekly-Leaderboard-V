export function createRouter() {
  const routes = [];

  function compile(pattern) {
    const keys = [];
    const source = pattern.replace(/\/:([A-Za-z0-9_]+)/g, (_, key) => {
      keys.push(key);
      return '/([^/]+)';
    });
    return { re: new RegExp('^' + source + '$'), keys };
  }

  function add(method, pattern, handler) {
    routes.push({ method, pattern, ...compile(pattern), handler });
  }

  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    match(method, pathname) {
      const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
      for (const route of routes) {
        if (route.method !== method) continue;
        const m = route.re.exec(path);
        if (!m) continue;
        const params = {};
        route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        return { route, params };
      }
      return null;
    },
    list: () => routes.map((r) => r.method + ' ' + r.pattern)
  };
}
