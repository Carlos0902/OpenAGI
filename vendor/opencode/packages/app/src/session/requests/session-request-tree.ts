import type { FormInfo, PermissionRequest, SessionInfo } from "@opencode/client/promise"

/** Completed module history stays visible without repeatedly loading parked-request endpoints for every entry. */
export function workflowRequestIDs(input: {
  main?: string
  members: readonly string[]
  recent: readonly string[]
  running: readonly string[]
  parked: readonly string[]
}) {
  const live = new Set([input.main, ...input.recent, ...input.running, ...input.parked])
  return input.members.filter((id) => live.has(id))
}

function sessionTreeRequest<T>(
  session: SessionInfo[],
  request: Record<string, T[] | undefined> | ((sessionID: string) => T[] | undefined),
  sessionID?: string,
  include: (item: T) => boolean = () => true,
  members?: readonly string[],
) {
  const ids = sessionTreeIDs(session, sessionID, members)

  if (!ids.length) return
  const list = (id: string) => (typeof request === "function" ? request(id) : request[id])
  const id = ids.find((id) => list(id)?.some(include))

  if (!id) return

  return list(id)?.find(include)
}

export function sessionTreeIDs(session: SessionInfo[], sessionID?: string, members: readonly string[] = []) {
  if (!sessionID) return []

  const map = session.reduce((acc, item) => {
    if (!item.parentID) return acc
    const list = acc.get(item.parentID)

    if (list) list.push(item.id)

    if (!list) acc.set(item.parentID, [item.id])

    return acc
  }, new Map<string, string[]>())

  const seen = new Set([sessionID, ...members])
  const ids = [...seen]

  for (const id of ids) {
    const list = map.get(id)

    if (!list) continue

    for (const child of list) {
      if (seen.has(child)) continue
      seen.add(child)
      ids.push(child)
    }
  }

  return ids
}

export function sessionPermissionRequest(
  session: SessionInfo[],
  request: Record<string, PermissionRequest[] | undefined> | ((sessionID: string) => PermissionRequest[] | undefined),
  sessionID?: string,
  include?: (item: PermissionRequest) => boolean,
  members?: readonly string[],
) {
  return sessionTreeRequest(session, request, sessionID, include, members)
}

export function sessionFormRequest(
  session: SessionInfo[],
  request: Record<string, FormInfo[] | undefined> | ((sessionID: string) => FormInfo[] | undefined),
  sessionID?: string,
  members?: readonly string[],
) {
  return sessionTreeRequest(
    session,
    request,
    sessionID,
    (item) => item.metadata?.kind === "question" || item.metadata?.kind === "websearch.provider",
    members,
  )
}
