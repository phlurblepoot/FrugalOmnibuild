// Parses the router pathname into the structured location the realtime
// server keys presence and rooms on. Kept dependency-free for testability.
export interface ClientLocationInfo {
  path: string;
  projectId?: string;
  section?: string;
  pageId?: string;
  fileId?: string;
  label?: string;
}

export function locationFromPath(pathname: string, search: string, label?: string): ClientLocationInfo {
  let projectId: string | undefined;
  let section: string | undefined;
  let pageId: string | undefined;
  let fileId: string | undefined;

  const projectMatch = pathname.match(/^\/project\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?/);
  if (projectMatch) {
    projectId = projectMatch[1];
    section = projectMatch[2] || 'overview';
    if (projectMatch[2] === 'page' && projectMatch[3]) pageId = projectMatch[3];
  }
  // The document editor names the file it has open, so Documents rows can
  // show who is in it (FileViewerDots).
  if (pathname === '/tools/edit') {
    fileId = new URLSearchParams(search).get('fileId') || undefined;
  }
  return { path: pathname, projectId, section, pageId, fileId, label };
}

/** Routes that render on their own, with no app chrome around them: the sign-in
 *  page and the fresh-install restore screen. Both run before there is an
 *  account or any data to navigate to. Kept in one place because the layout,
 *  the shell and the sidebar each have to agree — they drifted apart once
 *  already when /restore was added. */
export function isBareRoute(pathname: string): boolean {
  return pathname === '/login' || pathname === '/restore';
}
