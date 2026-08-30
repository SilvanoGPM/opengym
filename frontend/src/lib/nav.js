// Lets non-component modules (sheet flows) navigate. App registers the router's navigate.
let _nav = () => {}
export const setNav = fn => { _nav = fn }
// `options` is forwarded so a caller can pass router state — how a sheet hands the chat the
// session it should open on. Dropping it silently was easy to miss: navigation still worked,
// and only the state went missing.
export const nav = (to, options) => _nav(to, options)
