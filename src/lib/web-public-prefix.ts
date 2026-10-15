/** Path prefix when the web UI is mounted under another site.
 *  Empty at the relay root and inside the desktop webview. */
export function webPublicPrefix(pathname: string): string {
  if (pathname === "/CCGUI" || pathname.startsWith("/CCGUI/")) return "/CCGUI";
  return "";
}
