// Lightweight stand-in for matrix-js-sdk (ESM-only, huge). Only the enum values the UI code reads.
module.exports = {
  ClientEvent: { Sync: "sync", Room: "Room" },
  RoomEvent: { Timeline: "Room.timeline", LocalEchoUpdated: "Room.localEchoUpdated" },
  RoomStateEvent: { Events: "RoomState.events" },
  RoomMemberEvent: { Typing: "RoomMember.typing", Membership: "RoomMember.membership" },
  MatrixEventEvent: { Replaced: "Event.replaced" },
  SyncState: { Prepared: "PREPARED", Error: "ERROR" },
  createClient: () => { throw new Error("matrix-js-sdk is stubbed in tests"); },
};
