export interface RoomMotionState {
  available: boolean;
  reduced: boolean;
}

export interface MotionEnvironment {
  document: EventTarget & { readonly hidden: boolean };
  media: EventTarget & { readonly matches: boolean };
  observe: (element: Element, notify: (visible: boolean) => void) => () => void;
}

function browserEnvironment(): MotionEnvironment {
  return {
    document,
    media: window.matchMedia("(prefers-reduced-motion: reduce)"),
    observe(element, notify) {
      if (!("IntersectionObserver" in window)) return () => {};
      const observer = new IntersectionObserver(([entry]) => notify(entry.isIntersecting), { threshold: 0 });
      observer.observe(element);
      return () => observer.disconnect();
    },
  };
}

export function observeRoomMotion(
  element: Element,
  notify: (state: RoomMotionState) => void,
  environment: MotionEnvironment = browserEnvironment(),
): () => void {
  let visible = false;
  let disposed = false;
  const publish = () => {
    if (!disposed) {
      notify({
        available: visible && !environment.document.hidden && !environment.media.matches,
        reduced: environment.media.matches,
      });
    }
  };

  environment.document.addEventListener("visibilitychange", publish);
  environment.media.addEventListener("change", publish);
  publish();
  const disconnect = environment.observe(element, (value) => {
    visible = value;
    publish();
  });

  return () => {
    disposed = true;
    disconnect();
    environment.document.removeEventListener("visibilitychange", publish);
    environment.media.removeEventListener("change", publish);
  };
}
