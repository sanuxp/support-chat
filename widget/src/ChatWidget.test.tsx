import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatWidget } from "./ChatWidget";
import { axe } from "./test/axe";

const mockClient = { on: jest.fn(), off: jest.fn(), getRoom: jest.fn(() => null), stopClient: jest.fn(), sendTextMessage: jest.fn() };
const mockConnect = jest.fn();

jest.mock("./matrixClient", () => ({
  connect: (...a: unknown[]) => mockConnect(...a),
  deleteConversation: jest.fn(async () => {}),
}));

const opts = { backendUrl: "http://backend" };

beforeEach(() => {
  mockConnect.mockResolvedValue({ client: mockClient, session: { roomId: "!r:x", userId: "@customer_1:x" }, backendUrl: "" });
});

async function openChat() {
  const user = userEvent.setup();
  render(<ChatWidget opts={opts} />);
  await user.click(screen.getByRole("button", { name: /open support chat/i }));
  const input = await screen.findByLabelText("Message");
  await waitFor(() => expect(input).toBeEnabled());
  return { user, input };
}

describe("ChatWidget accessibility", () => {
  it("has an accessible launcher and no axe violations when closed", async () => {
    const { container } = render(<ChatWidget opts={opts} />);
    expect(screen.getByRole("button", { name: /open support chat/i })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no axe violations when open", async () => {
    const { container } = render(<ChatWidget opts={opts} />);
    await userEvent.setup().click(screen.getByRole("button", { name: /open support chat/i }));
    await screen.findByRole("log", { name: "Messages" });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("moves focus into the dialog on open", async () => {
    const { input } = await openChat();
    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Support chat");
  });

  it("closes on Escape and returns focus to the launcher", async () => {
    const { user } = await openChat();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open support chat/i })).toHaveFocus();
  });

  it("closes via the labelled close button", async () => {
    const { user } = await openChat();
    await user.click(screen.getByRole("button", { name: "Close support chat" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("delete confirmation is an alertdialog that takes focus and Escape only cancels it", async () => {
    const { user } = await openChat();
    await user.click(screen.getByRole("button", { name: "Delete conversation" }));
    const confirm = screen.getByRole("alertdialog", { name: "Confirm delete" });
    expect(confirm).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument(); // chat itself stays open
  });

  it("announces connection errors with role=alert", async () => {
    mockConnect.mockRejectedValueOnce(new Error("down"));
    const user = userEvent.setup();
    render(<ChatWidget opts={opts} />);
    await user.click(screen.getByRole("button", { name: /open support chat/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not connect/i);
  });

  it("exposes the message list as a labelled, keyboard-focusable live log", async () => {
    await openChat();
    const log = screen.getByRole("log", { name: "Messages" });
    expect(log).toHaveAttribute("aria-live", "polite");
    expect(log).toHaveAttribute("tabindex", "0");
  });
});
