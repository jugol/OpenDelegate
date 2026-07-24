import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("the first-run Device overview keeps Configuration Chat isolated and usable", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await page.goto("/");
  const compactViewport = (page.viewportSize()?.width ?? 0) <= 819;

  await expect(page).toHaveTitle("OpenDelegate");
  await expect(page.locator("h1", { hasText: "Mac Studio" })).toBeVisible();
  const dialog = page.getByRole("dialog", {
    name: "Configuration Chat",
  });
  const appFrame = page.locator(".app-frame");
  const composer = page.getByRole("textbox", {
    name: "Message Configuration Chat",
  });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Configuration Chat" })).toHaveCount(0);

  if (compactViewport) {
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(appFrame).toHaveAttribute("inert", "");
    await expect(appFrame).toHaveAttribute("aria-hidden", "true");
    await expect(composer).toBeFocused();

    const expand = page.getByRole("button", { name: "Expand Configuration Chat" });
    await expand.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(composer).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(expand).toBeFocused();
  } else {
    await expect(dialog).toHaveAttribute("aria-modal", "false");
    await expect(appFrame).not.toHaveAttribute("inert", "");
    await expect(appFrame).not.toHaveAttribute("aria-hidden", "true");
    await expect(page.getByRole("button", { name: "Tasks" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Join a device" })).toBeVisible();
  }

  await composer.fill("Preserve this browser draft");
  await page
    .getByRole("button", {
      name: "Close Configuration Chat",
    })
    .click();
  await expect(page.getByRole("dialog", { name: "Configuration Chat" })).toHaveCount(0);
  const launcher = page.getByRole("button", { name: "Open Configuration Chat" });
  await expect(launcher).toBeFocused();

  await page
    .getByRole("button", {
      name: "Configure",
    })
    .click();
  await expect(composer).toHaveValue("Preserve this browser draft");
  await expect(composer).toBeFocused();

  await composer.fill("Keep Tailscale as fallback.");
  await page.getByRole("button", { name: "Send message" }).click();
  await composer.fill("Do not change firewall settings.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(composer).toBeInViewport();
  await expect(page.getByRole("button", { name: "Send message" })).toBeInViewport();
  await composer.fill("Keep this expanded browser draft");

  await page
    .getByRole("button", {
      name: "Expand Configuration Chat",
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Restore Configuration Chat",
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Configuration Chat" })).toHaveCount(0);
  await expect(composer).toHaveValue("Keep this expanded browser draft");
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(appFrame).toHaveAttribute("inert", "");
  await expect(appFrame).toHaveAttribute("aria-hidden", "true");
  await page
    .getByRole("button", {
      name: "Restore Configuration Chat",
    })
    .click();
  await expect(composer).toHaveValue("Keep this expanded browser draft");
  await expect(dialog).toHaveAttribute("aria-modal", compactViewport ? "true" : "false");
  if (compactViewport) {
    await expect(appFrame).toHaveAttribute("inert", "");
  } else {
    await expect(appFrame).not.toHaveAttribute("inert", "");
  }

  await page
    .getByRole("button", {
      name: "Review change",
    })
    .click();
  await expect(page.getByTestId("role-diff")).toHaveText("+Computer Use");
  await expect(page.getByTestId("capability-diff").locator(".proposal-transition")).toHaveText(
    "Detected→Verified",
  );
  await expect(page.getByTestId("capability-diff").locator(".sr-only")).toHaveText(
    "Detected to Verified",
  );

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("Configuration Chat closes with Escape and returns focus to its opener", async ({ page }) => {
  await page.goto("/");
  const compactViewport = (page.viewportSize()?.width ?? 0) <= 819;
  const appFrame = page.locator(".app-frame");
  const initialDialog = page.getByRole("dialog", { name: "Configuration Chat" });

  await expect(initialDialog).toHaveAttribute("aria-modal", compactViewport ? "true" : "false");
  if (compactViewport) {
    await expect(
      page.getByRole("textbox", {
        name: "Message Configuration Chat",
      }),
    ).toBeFocused();
    await expect(appFrame).toHaveAttribute("inert", "");
  }

  await page
    .getByRole("button", {
      name: "Close Configuration Chat",
    })
    .click();

  const launcher = page.getByRole("button", {
    name: "Open Configuration Chat",
  });
  await expect(launcher).toBeFocused();
  await launcher.click();
  const reopenedDialog = page.getByRole("dialog", { name: "Configuration Chat" });
  await expect(reopenedDialog).toHaveAttribute("aria-modal", compactViewport ? "true" : "false");
  await expect(page.getByRole("textbox", { name: "Message Configuration Chat" })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Configuration Chat" })).toHaveCount(0);
  await expect(appFrame).not.toHaveAttribute("inert", "");
  await expect(launcher).toBeFocused();
});
