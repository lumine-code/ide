const fs = require("fs");
const path = require("path");

describe("ide package assets", () => {
  const manifest = require("../package.json");

  it("ships one grouped Packages submenu for every workspace command", () => {
    expect(manifest.files).toContain("menus");
    const menu = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "menus", "main.json")));
    expect(Object.keys(menu)).toEqual(["menu"]);
    expect(menu.menu[0].label).toBe("Packages");
    const packageMenu = menu.menu[0].submenu[0];
    expect(packageMenu.label).toBe("IDE");
    const groups = [[]];
    for (const item of packageMenu.submenu) {
      if (item.type === "separator") groups.push([]);
      else groups.at(-1).push(item.command);
    }
    expect(groups).toEqual([
      [
        "ide:servers",
        "ide:manage-servers",
        "ide:restart",
        "ide:show-log",
        "ide:open-custom-servers-file",
      ],
      ["ide:toggle-problems", "ide:format"],
      [
        "ide:fold-server-ranges",
        "ide:expand-selection-range",
        "ide:select-linked-ranges",
        "ide:color-presentation",
      ],
    ]);
    expect(packageMenu.submenu.at(-1).label).toBe("Color Presentation…");
  });

  it("provides document links through the hyperclick service", () => {
    expect(manifest.providedServices["hyperclick.provider"].versions["1.0.0"]).toBe(
      "provideHyperclick",
    );
  });

  it("provides context help separately from signature help", () => {
    expect(manifest.providedServices["context-help.provider"].versions["1.0.0"]).toBe(
      "provideContextHelp",
    );
    expect(manifest.providedServices["hover.provider"]).toBeUndefined();
    expect(manifest.providedServices["hover.signature-provider"].versions["1.0.0"]).toBe(
      "provideHoverSignature",
    );
  });
});
