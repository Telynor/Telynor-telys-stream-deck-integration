const MODULE_ID = "telys-stream-deck-integration";
let moduleApi = null;

function getModuleApi() {
  return moduleApi ?? game.modules.get(MODULE_ID)?.api ?? null;
}

function reconnectBridge() {
  const bridge = getModuleApi()?.bridge;
  if (!bridge) return;
  bridge.connect();
}

class ActionRegistry {
  #actions = new Map();

  register(definition) {
    if (!definition?.id || typeof definition.execute !== "function") {
      throw new Error("A Stream Deck action needs an id and execute function.");
    }
    const normalized = {
      name: definition.id,
      group: "Foundry",
      icon: null,
      permission: () => true,
      describeState: null,
      ...definition
    };
    this.#actions.set(normalized.id, normalized);
    Hooks.callAll("telysStreamDeckCatalogChanged", this.catalog());
    return () => this.#actions.delete(normalized.id);
  }

  unregister(id) {
    return this.#actions.delete(id);
  }

  get(id) {
    return this.#actions.get(id);
  }

  catalog(user = game.user) {
    return [...this.#actions.values()]
      .filter((action) => action.permission(user))
      .map(({ id, name, group, icon }) => ({ id, name, group, icon }));
  }
}

class DeckBridge {
  constructor(registry) {
    this.registry = registry;
    this.socket = null;
    this.retryTimer = null;
    this.reconnectDelay = 1000;
    this.connected = false;
  }

  connect() {
    if (!game.settings.get(MODULE_ID, "autoConnect")) return;
    this.disconnect(false);
    const port = game.settings.get(MODULE_ID, "port");
    this.socket = new WebSocket(`ws://127.0.0.1:${port}`);

    this.socket.addEventListener("open", () => {
      this.connected = true;
      this.reconnectDelay = 1000;
      this.send({
        type: "hello",
        protocol: 1,
        secret: game.settings.get(MODULE_ID, "pairingSecret"),
        user: { id: game.user.id, name: game.user.name, isGM: game.user.isGM },
        world: { id: game.world.id, title: game.world.title },
        catalog: this.registry.catalog()
      });
      ui.notifications.info("Stream Deck connected.");
    });

    this.socket.addEventListener("message", (event) => this.#onMessage(event));
    this.socket.addEventListener("close", () => this.#scheduleReconnect());
    this.socket.addEventListener("error", () => this.socket?.close());
  }

  disconnect(reconnect = false) {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
    this.connected = false;
    if (reconnect) this.#scheduleReconnect();
  }

  send(message) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  publishState(actionId, state) {
    this.send({ type: "state", actionId, state });
  }

  refreshCatalog() {
    this.send({ type: "catalog", catalog: this.registry.catalog() });
  }

  async #onMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type !== "execute") return;

    const action = this.registry.get(message.actionId);
    if (!action || !action.permission(game.user)) {
      return this.send({ type: "result", requestId: message.requestId, ok: false, error: "Action unavailable or not permitted." });
    }

    try {
      const result = await action.execute({
        payload: message.payload ?? {},
        user: game.user,
        actionContext: message.actionContext
      });
      this.send({ type: "result", requestId: message.requestId, ok: true, result: result ?? null });
    } catch (error) {
      console.error(`${MODULE_ID} | Action failed`, error);
      ui.notifications.error(`Stream Deck: ${error.message}`);
      this.send({ type: "result", requestId: message.requestId, ok: false, error: error.message });
    }
  }

  #scheduleReconnect() {
    this.connected = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15000);
  }
}

function getUuid(payload) {
  const uuid = payload.uuid ?? payload.documentUuid ?? payload.target;
  if (!uuid) throw new Error("No Foundry document was configured for this key.");
  return uuid;
}

async function openDocument(payload) {
  const document = await fromUuid(getUuid(payload));
  if (!document) throw new Error("The configured Foundry document no longer exists.");
  if (!document.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER)) {
    throw new Error("You do not have permission to open that document.");
  }
  return document.sheet?.render(true);
}

function registerCoreActions(registry) {
  registry.register({ id: "foundry.open-document", name: "Open Document", group: "Foundry", execute: ({ payload }) => openDocument(payload) });

  registry.register({
    id: "foundry.run-macro",
    name: "Run Macro",
    group: "Foundry",
    execute: async ({ payload }) => {
      const macro = await fromUuid(getUuid(payload));
      if (!(macro instanceof Macro)) throw new Error("The configured document is not a Macro.");
      if (!macro.canExecute) throw new Error("You do not have permission to execute that macro.");
      return macro.execute({ streamDeck: true, payload: payload.arguments ?? {} });
    }
  });

  registry.register({
    id: "foundry.select-token",
    name: "Select Token",
    group: "Canvas",
    execute: async ({ payload }) => {
      const tokenDoc = await fromUuid(getUuid(payload));
      const token = tokenDoc?.object;
      if (!token) throw new Error("The configured token is not on the active scene.");
      if (!token.isOwner) throw new Error("You do not own that token.");
      token.control({ releaseOthers: !payload.additive });
      await canvas.animatePan({ x: token.center.x, y: token.center.y, scale: canvas.stage.scale.x });
    }
  });

  registry.register({
    id: "foundry.target-token",
    name: "Target Token",
    group: "Canvas",
    execute: async ({ payload }) => {
      const tokenDoc = await fromUuid(getUuid(payload));
      const token = tokenDoc?.object;
      if (!token) throw new Error("The configured token is not on the active scene.");
      token.setTarget(payload.targeted ?? !token.isTargeted, { releaseOthers: !payload.additive });
    }
  });

  registry.register({
    id: "foundry.sidebar",
    name: "Open Sidebar Tab",
    group: "Foundry",
    execute: ({ payload }) => {
      const tab = payload.tab ?? payload.target;
      if (!ui.sidebar.tabs[tab]) throw new Error(`Unknown sidebar tab: ${tab}`);
      ui.sidebar.activateTab(tab);
    }
  });
}

function clickFirst(selectors) {
  const element = selectors.map((selector) => document.querySelector(selector)).find(Boolean);
  if (!element) throw new Error("That Star Rail control is not available in the current UI.");
  element.click();
}

function registerStarRailAdapter(registry) {
  const moduleActive = () => game.modules.get("telys-star-rail-ultimates")?.active;
  const visible = (user) => moduleActive() && user.active;

  registry.register({
    id: "star-rail.open-hub", name: "Open HSR Hub", group: "Star Rail", permission: visible,
    execute: () => clickFirst(["[data-tool='hsr-hub']", "[data-control='hsr-hub']", ".tely-hsr-hub-button"])
  });
  registry.register({
    id: "star-rail.open-missions", name: "Open Missions", group: "Star Rail", permission: visible,
    execute: () => clickFirst(["[data-action='open-missions']", "[data-tool='missions']", ".hsr-missions-button"])
  });
  registry.register({
    id: "star-rail.open-gm-panel", name: "Open GM Panel", group: "Star Rail", permission: (user) => moduleActive() && user.isGM,
    execute: () => clickFirst(["[data-action='open-gm-panel']", "[data-tool='hsr-gm-panel']", ".hsr-gm-panel-button"])
  });
  registry.register({
    id: "star-rail.aha-instant", name: "Aha Instant", group: "Star Rail", permission: (user) => moduleActive() && user.isGM,
    execute: ({ payload }) => Hooks.callAll("telysStreamDeckStarRailAction", "aha-instant", payload)
  });
  registry.register({
    id: "star-rail.ultimate", name: "Activate Ultimate", group: "Star Rail", permission: visible,
    execute: async ({ payload }) => {
      const actor = await fromUuid(payload.actorUuid ?? payload.uuid);
      if (!(actor instanceof Actor)) throw new Error("No valid Actor is configured for this ultimate.");
      if (!actor.isOwner) throw new Error("You do not own that Actor.");
      Hooks.callAll("telysStreamDeckStarRailAction", "ultimate", { ...payload, actor });
    }
  });
}

function registerSettings() {
  game.settings.register(MODULE_ID, "port", {
    name: "Local Bridge Port", hint: "The local port used by the Stream Deck plugin.", scope: "client", config: true,
    type: Number, default: 17321, onChange: reconnectBridge
  });
  game.settings.register(MODULE_ID, "pairingSecret", {
    name: "Pairing Secret", hint: "Must match the secret configured on your Stream Deck keys.", scope: "client", config: true,
    type: String, default: "", onChange: reconnectBridge
  });
  game.settings.register(MODULE_ID, "autoConnect", {
    name: "Connect to Stream Deck", hint: "Connect this browser to the local Stream Deck plugin.", scope: "client", config: true,
    type: Boolean, default: true,
    onChange: (enabled) => {
      const bridge = getModuleApi()?.bridge;
      if (!bridge) return;
      enabled ? bridge.connect() : bridge.disconnect();
    }
  });
}

Hooks.once("init", () => {
  registerSettings();
  const registry = new ActionRegistry();
  const bridge = new DeckBridge(registry);
  registerCoreActions(registry);
  registerStarRailAdapter(registry);
  moduleApi = {
    registerAction: (definition) => registry.register(definition),
    unregisterAction: (id) => registry.unregister(id),
    catalog: () => registry.catalog(),
    publishState: (actionId, state) => bridge.publishState(actionId, state),
    bridge
  };
  game.modules.get(MODULE_ID).api = moduleApi;
});

Hooks.once("ready", () => {
  const api = getModuleApi();
  if (!api?.bridge) {
    console.error(`${MODULE_ID} | Bridge API was not initialized.`);
    return;
  }
  Hooks.callAll("telysStreamDeckReady", api);
  api.bridge.connect();
});

Hooks.on("telysStreamDeckCatalogChanged", () => getModuleApi()?.bridge?.refreshCatalog());
