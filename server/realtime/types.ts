export interface LocationInfo {
  path: string;          // location.pathname, e.g. "/project/abc/billing"
  projectId?: string;
  section?: string;      // "billing" | "issues" | "takeoff" | ... (last route segment under /project/:id)
  pageId?: string;       // canvas page UUID when on /project/:id/page/:pageId
  fileId?: string;       // file open in the document editor (/tools/edit?fileId=...)
  label?: string;        // human-readable page label (old "pageName"), client-supplied
}

export interface SessionInfo {
  sessionId: string;     // socket.id (server-assigned, unique per connection)
  userId: string;        // from verified JWT (payload.id)
  name: string;          // from verified JWT (payload.username)
  role: string;          // from verified JWT (payload.role)
  color: string;
  device: string;        // deviceLabel() output
  location: LocationInfo | null;
  editing: { type: string; id: string } | null;  // declared in WS2; carried now
  cursor: { x: number; y: number } | null;
  lastActive: number;    // epoch ms
}
