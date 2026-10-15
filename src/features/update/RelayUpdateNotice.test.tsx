import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RelayUpdateInfo } from "@/lib/ipc";

const mock = vi.hoisted(() => ({ web:false, status:vi.fn(), defer:vi.fn(), blackout:vi.fn(), listen:vi.fn() }));
vi.mock("@/lib/transport", () => ({ get isWeb() { return mock.web; }, listen:mock.listen }));
vi.mock("@/lib/ipc", () => ({ ipc:{relayUpdateStatus:mock.status,relayUpdateDefer:mock.defer,relayUpdateBlackout:mock.blackout} }));
vi.mock("react-i18next", () => ({useTranslation:() => ({t:(key:string, args?:{version?:string}) => key + (args?.version ? ":" + args.version : "")})}));
vi.mock("@/components/base/buttons/button", () => ({Button:({children,onClick}:{children:React.ReactNode;onClick:() => void}) => <button onClick={onClick}>{children}</button>}));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const info: RelayUpdateInfo = {version:"1.2.1",phase:"waiting-idle",error:null,failedVersion:null,deferredUntil:0,blackoutStart:null,blackoutEnd:null};
beforeEach(() => {
  vi.clearAllMocks(); mock.web=false;
  mock.status.mockResolvedValue(info); mock.listen.mockResolvedValue(vi.fn());
  container=document.createElement("div"); document.body.appendChild(container); root=createRoot(container);
});
afterEach(() => {act(() => root.unmount());container.remove();});
async function render() { const {RelayUpdateNotice}=await import("./RelayUpdateNotice");await act(async () => root.render(<RelayUpdateNotice />)); }

it("shows idle installation and saves a one-hour deferral", async () => {
  mock.defer.mockResolvedValue({...info,deferredUntil:Date.now()+3_600_000});
  await render();
  expect(container.textContent).toContain("settings.relayUpdateIdle:1.2.1");
  const button=[...container.querySelectorAll("button")].find((b) => b.textContent === "settings.relayUpdateDefer")!;
  await act(async () => button.click());
  expect(mock.defer).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("settings.relayUpdateDeferred");
});

it("keeps a newer pushed state when the initial status query arrives late", async () => {
  let resolve!: (value:RelayUpdateInfo) => void;
  mock.status.mockReturnValue(new Promise<RelayUpdateInfo>((done) => {resolve=done;}));
  await render();
  const receive=mock.listen.mock.calls[0][1];
  await act(async () => {receive({payload:{...info,version:"1.2.2",phase:"installing"}});resolve(info);});
  expect(container.textContent).toContain("settings.relayUpdateInstalling:1.2.2");
  expect(container.querySelectorAll("button")).toHaveLength(0);
});

it("removes a subscription that resolves after unmount", async () => {
  let resolve!: (off:() => void) => void;
  mock.listen.mockReturnValue(new Promise<() => void>((done) => {resolve=done;}));
  await render(); act(() => root.unmount());
  const off=vi.fn();await act(async () => resolve(off));
  expect(off).toHaveBeenCalledTimes(1);
  root=createRoot(container);
});

it("does not call executor update commands from the web page", async () => {
  mock.web=true;await render();
  expect(mock.status).not.toHaveBeenCalled();expect(mock.listen).not.toHaveBeenCalled();expect(container.textContent).toBe("");
});
