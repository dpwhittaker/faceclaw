import type { CueTransportFactory } from "./cue-channel";

declare const com: any;

/** The cue channel's websocket on Android: Faceclaw's OkHttp socket with the backend's bearer token. */
export const androidCueTransport: CueTransportFactory = (url, token, handlers) => {
  let closed = false;
  // A socket can fail and then close; the channel hears about it once.
  const close = (reason: string) => {
    if (closed) return;
    closed = true;
    handlers.onClose(reason);
  };
  const listener = new com.faceclaw.app.FaceclawWebSocketListener({
    onOpen: () => handlers.onOpen(),
    onTextMessage: (message: string) => handlers.onMessage(String(message)),
    onClosed: () => close("closed"),
    onFailure: (message: string) => close(String(message)),
  });
  const socket = new com.faceclaw.app.FaceclawWebSocket(url, listener, "Authorization", `Bearer ${token}`);
  return {
    send: (text) => {
      try {
        return socket.sendText(text) !== false;
      } catch {
        return false;
      }
    },
    close: () => {
      closed = true;
      // Held here so the Java callbacks' JS side isn't collected while the socket lives.
      void listener;
      try {
        socket.close(1000, "bye");
      } catch {
        // Already gone.
      }
    },
  };
};
