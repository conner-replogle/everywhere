// The capture host: an extension page in the daemon's Chromium that captures
// tabs (chrome.tabCapture) and sends each one to its viewers over WebRTC, so
// Chrome's own encoder, congestion control and retransmission do the work.
// The daemon drives it with Runtime.evaluate and hears back through the
// __everywhereVideo binding; SDP and ICE candidates ride the tab's browser
// channel to the viewer.

const tabs = new Map(); // key -> { track, viewers: Set<id> }
const viewers = new Map(); // id -> { key, pc, sender }

const emit = (msg) => self.__everywhereVideo?.(JSON.stringify(msg));

async function tabIdOf(targetId) {
  const t = (await chrome.debugger.getTargets()).find((t) => t.id === targetId);
  if (!t || t.tabId === undefined) throw new Error("the page's tab is gone");
  return t.tabId;
}

// A tab can only be captured once at a time, and a capture's size is fixed
// when it starts, so a new size means stopping the old capture first.
self.capture = async (key, targetId, width, height) => {
  const tab = tabs.get(key) ?? { track: null, viewers: new Set() };
  tabs.set(key, tab);
  tab.track?.stop();
  tab.track = null;
  await new Promise((r) => setTimeout(r));
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: await tabIdOf(targetId) });
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        minWidth: width,
        maxWidth: width,
        minHeight: height,
        maxHeight: height,
        maxFrameRate: 60,
      },
    },
  });
  const track = stream.getVideoTracks()[0];
  track.contentHint = "detail"; // text stays sharp; frame rate gives way first
  if (tabs.get(key) !== tab) {
    track.stop(); // released while starting
    return;
  }
  tab.track = track;
  track.onended = () => {
    if (tab.track === track) emit({ t: "ended", key });
  };
  await Promise.all([...tab.viewers].map((id) => viewers.get(id)?.sender.replaceTrack(track)));
};

self.release = (key) => {
  const tab = tabs.get(key);
  if (!tab) return;
  tabs.delete(key);
  tab.track?.stop();
  for (const id of tab.viewers) hangup(id);
};

// answer takes a viewer's offer and returns the answer; candidates trickle
// through emit and ice().
self.answer = async (key, id, sdp, iceServers, maxKbps) => {
  hangup(id);
  const tab = tabs.get(key);
  if (!tab?.track) throw new Error("the tab isn't being captured");
  const pc = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });
  const sender = pc.addTrack(tab.track);
  viewers.set(id, { key, pc, sender });
  tab.viewers.add(id);
  pc.onicecandidate = (e) => {
    if (e.candidate) emit({ t: "ice", key, viewer: id, candidate: e.candidate.toJSON() });
  };
  await pc.setRemoteDescription({ type: "offer", sdp });
  await pc.setLocalDescription();
  await tune(id, maxKbps);
  return pc.localDescription.sdp;
};

self.ice = (id, candidate) => viewers.get(id)?.pc.addIceCandidate(candidate).catch(() => {});

const tune = async (id, maxKbps) => {
  const v = viewers.get(id);
  if (!v) return;
  const p = v.sender.getParameters();
  if (!p.encodings?.length) return;
  p.degradationPreference = "maintain-resolution";
  for (const e of p.encodings) e.maxBitrate = maxKbps * 1000;
  await v.sender.setParameters(p).catch(() => {});
};
self.tune = tune;

function hangup(id) {
  const v = viewers.get(id);
  if (!v) return;
  viewers.delete(id);
  tabs.get(v.key)?.viewers.delete(id);
  v.pc.close();
}
self.hangup = hangup;

self.ready = true;
