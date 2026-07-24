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

  await expect(page).toHaveTitle("OpenDelegate");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Mac Studio",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", {
      name: "Configuration Chat",
    }),
  ).toBeVisible();

  if ((page.viewportSize()?.width ?? 0) >= 820) {
    await expect(page.getByRole("button", { name: "Tasks" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Join a device" })).toBeVisible();
  }

  const composer = page.getByRole("textbox", {
    name: "Message Configuration Chat",
  });
  await composer.fill("Preserve this browser draft");
  await page
    .getByRole("button", {
      name: "Collapse Configuration Chat",
    })
    .click();
  await expect(
    page.getByRole("dialog", {
      name: "Configuration Chat",
    }),
  ).toHaveCount(0);

  await page
    .getByRole("button", {
      name: "Configure",
    })
    .click();
  await expect(composer).toHaveValue("Preserve this browser draft");

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
  await expect(composer).toHaveValue("Preserve this browser draft");
  await page
    .getByRole("button", {
      name: "Restore Configuration Chat",
    })
    .click();
  await expect(composer).toHaveValue("Preserve this browser draft");

  await page
    .getByRole("button", {
      name: "Review change",
    })
    .click();
  await expect(page.getByTestId("role-diff")).toHaveText("+Computer Use");
  await expect(page.getByTestId("capability-diff")).toHaveText("computer-useDetected→Verified");

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);
  expect(consoleErrors).toEqual([]);
});
