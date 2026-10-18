// Best-effort UA → "OS · Browser" label for the online-sessions list.
// Order matters: Edge UAs contain "Chrome"; Chrome UAs contain "Safari";
// iPad/iPhone UAs contain "Mac OS X". Modern iPadOS Safari masquerades as
// Macintosh — "Mac · Safari" for those is an accepted imperfection.
export function deviceLabel(userAgent: string | undefined): string {
  if (!userAgent) return 'Unknown device';
  const ua = userAgent;

  let os = 'Unknown';
  if (/iPad/i.test(ua)) os = 'iPad';
  else if (/iPhone/i.test(ua)) os = 'iPhone';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Macintosh|Mac OS X/i.test(ua)) os = 'Mac';
  else if (/Linux|X11/i.test(ua)) os = 'Linux';

  let browser = 'Browser';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Chrome\/|CriOS\//i.test(ua)) browser = 'Chrome';
  else if (/Safari\//i.test(ua)) browser = 'Safari';

  if (os === 'Unknown' && browser === 'Browser') return 'Unknown device';
  return `${os} · ${browser}`;
}
