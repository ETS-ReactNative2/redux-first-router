import pathToAction from '../utils/pathToAction'
import actionToPath from '../utils/actionToPath'
import isRedirect, { isCommittedRedirect } from '../utils/isRedirect'
import isNotFound from '../utils/isNotFound'
import typeToScene from '../utils/typeToScene'
import { NOT_FOUND, UPDATE_HISTORY } from '../index'

export default (api) => async (req, next) => {
  const {
    route,
    routes,
    action,
    history,
    locationState,
    options: { basename: bn, querySerializer: serializer }
  } = req

  if (action.type !== UPDATE_HISTORY && !route.path) return next() // only create route actions if from history or routes with paths

  const state = locationState()
  const basename = state.basename || bn
  const prev = state.kind === 'init' ? state.prev : state

  try {
    if (action.type === UPDATE_HISTORY) {
      const { location } = action.nextHistory
      // const basename = location.basename
      const act = pathToAction(location, routes, basename, serializer)
      req = historyAction(req, act, prev, basename)
    }
    else if (!isNotFound(action)) {
      const url = actionToPath(action, routes, serializer)
      req = reduxAction(req, url, action, prev, history, basename)
    }
    else {
      const { type, url } = getNotFoundRoute(req, prev)
      action.type = type
      req = reduxAction(req, url, action, prev, history, basename)
    }
  }
  catch (e) {
    const { type, url } = getNotFoundRoute(req, prev)
    const payload = (action && action.payload) || {}
    const act = { ...action, type, payload }
    req = reduxAction(req, url, act, prev, history, basename)
  }

  if (isDoubleDispatch(req, state)) return req.action

  await next()
  return req.action
}


const historyAction = (req, action, prev, basename) => {
  req.route = req.routes[action.type]

  const { nextHistory } = req.action

  if (isNotFound(action)) {
    req.action = action
    action.type = getNotFoundRoute(req, prev).type                      // type may have changed to scene-level NOT_FOUND
  }

  req.action = nestAction(action, prev, nextHistory, basename)          // replace history-triggered action with real action intended for reducers
  return req
}


const reduxAction = (req, url, action, prev, history, bn) => {
  const basename = (action.location && action.location.basename) || bn  // allow basenames to be changed along with any route change
  if (basename !== bn) history.setBasename(basename)

  const state = action.state
  const method = isCommittedRedirect(action, req) ? 'redirect' : 'push' // redirects before committing are just pushes (since the original route was never pushed)
  const { nextHistory, commit } = history[method](url, state, false)       // get returned the same "bag" as functions passed to `history.listen`
  const redirect = isRedirect(action)

  prev = (redirect && req.tmp.prev) || prev                             // if multiple redirects in one pass, the latest LAST redirect becomes prev; otherwise, just use prev state

  nextHistory.kind = redirect ? 'redirect' : nextHistory.kind           // the kind no matter what relfects the appropriate intent

  req.action = nestAction(action, prev, nextHistory, basename)
  req.commitHistory = commit                                            // put these here so `enter` middleware can commit the history, etc

  return req
}


export const nestAction = (action, previous, history, basename) => {
  const { kind, entries, index, length, location } = history
  const { url, pathname, search } = location
  const { type, payload = {}, query = {}, state = {}, hash = '' } = action
  const scene = typeToScene(type)
  const prev = { ...previous }
  delete prev.prev

  return {
    ...action,
    type,
    payload,
    query,
    state,
    hash,
    location: {
      ...action.location,
      url,
      pathname,
      search,
      basename,
      scene,

      prev,

      kind,
      entries,
      index,
      length
    }
  }
}

const pick = (obj, keys) => keys.reduce((acc, k) => {
  if (obj[k] !== undefined) acc[k] = obj[k]
  return acc
}, {})


const isDoubleDispatch = (req, state) =>
  req.action.location.url === state.url && state.kind !== 'init' // on load, the `firstRoute` action will trigger the same URL as stored in state, and we need to dispatch it anyway :)


export const getNotFoundRoute = (req, prev) => {
  const { action = {}, routes, route, prevRoute } = req

  // NOT_FOUND action dispatched by user
  if (isNotFound(action)) {
    const scene = route.scene || prevRoute.scene
    const type = action.type.indexOf('/NOT_FOUND') > -1
      ? action.type
      : scene && routes[`${scene}/NOT_FOUND`] // try to interpret scene-level NOT_FOUND if available (note: links create plain NOT_FOUND actions)
        ? `${scene}/NOT_FOUND`
        : NOT_FOUND

    return {
      type,
      url: resolvePath(route, prev, action.meta && action.meta.notFoundPath)
    }
  }

  // error thrown in createRouteAction (probably from actionToPath)
  const scene = route.scene || prevRoute.scene
  const type = scene && routes[`${scene}/NOT_FOUND`]
    ? `${scene}/NOT_FOUND`
    : NOT_FOUND

  return {
    type,
    url: resolvePath(routes[type], prev, null, routes)
  }
}

const resolvePath = (route, prev, pathOverride, routes) =>
  pathOverride || route.path || routes[NOT_FOUND].path

