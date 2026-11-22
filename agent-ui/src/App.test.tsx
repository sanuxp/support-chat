import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { axe } from "./test/axe";

const mockApi = jest.fn();
jest.mock("./matrixClient", () => ({
  api: (...a: unknown[]) => mockApi(...a),
  loadSession: () => ({ userId: "@agent_a:x", accessToken: "tok", deviceId: "d" }),
  login: jest.fn(),
  logout: jest.fn(async () => {}),
  startClient: jest.fn(async () => ({ on: jest.fn(), off: jest.fn(), stopClient: jest.fn() })),
}));

beforeEach(() => {
  mockApi.mockResolvedValue({ conversations: [] });
});

describe("App accessibility", () => {
  it("has no axe violations once connected", async () => {
    const { container } = render(<App />);
    await screen.findByRole("region", { name: /waiting/i });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("offers a skip link that targets the main landmark", async () => {
    render(<App />);
    await screen.findByRole("region", { name: /waiting/i });
    expect(screen.getByRole("link", { name: /skip to main content/i })).toHaveAttribute("href", "#main");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
    expect(screen.getByRole("heading", { level: 1, name: "Agent console" })).toBeInTheDocument();
  });

  it("online toggle reports its state to assistive tech", async () => {
    const user = userEvent.setup();
    render(<App />);
    const toggle = await screen.findByRole("button", { name: /offline/i });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    expect(await screen.findByRole("button", { name: /online/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows errors as an alert with a keyboard-operable dismiss button", async () => {
    const user = userEvent.setup();
    mockApi.mockRejectedValue(new Error("Boom"));
    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Boom");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});
