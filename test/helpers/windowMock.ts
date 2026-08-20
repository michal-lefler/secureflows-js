export function attachPageHide(win: EventTarget): void {
  const target = new EventTarget();
  (win as EventTarget & { addEventListener: EventTarget['addEventListener'] }).addEventListener =
    target.addEventListener.bind(target);
  (win as EventTarget & { removeEventListener: EventTarget['removeEventListener'] }).removeEventListener =
    target.removeEventListener.bind(target);
  (win as EventTarget & { dispatchPageHide?: () => void }).dispatchPageHide = () => {
    target.dispatchEvent(new Event('pagehide'));
  };
}
