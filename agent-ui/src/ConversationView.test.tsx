import { render, screen, waitFor } from "@testing-library/react";
import { ConversationView } from "./ConversationView";
import { axe } from "./test/axe";

jest.mock("./matrixClient", () => ({ api: jest.fn(async () => ({})) }));

function fakeClient() {
  const room = {
    getLiveTimeline: () => ({ getEvents: () => [] }),
    currentState: { getStateEvents: () => undefined },
    getMember: () => null,
  };
  return {
    getUserId: () => "@agent_a:x",
    joinRoom: jest.fn(async () => {}),
    getRoom: () => room,
    paginateEventTimeline: jest.fn(async () => false),
    sendTextMessage: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
  } as any;
}

async function ready() {
  const view = render(<ConversationView client={fakeClient()} token="t" roomId="!r:x" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText("Reply to the customer")).toBeEnabled());
  return view;
}

describe("ConversationView accessibility", () => {
  it("has no axe violations", async () => {
    const { container } = await ready();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("exposes the transcript as a labelled, focusable live log", async () => {
    await ready();
    const log = screen.getByRole("log", { name: "Conversation messages" });
    expect(log).toHaveAttribute("aria-live", "polite");
    expect(log).toHaveAttribute("tabindex", "0");
  });

  it("labels the composer and the action buttons", async () => {
    await ready();
    expect(screen.getByRole("button", { name: /back to queue/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /resolve and return to ai/i })).toBeInTheDocument();
  });
});
