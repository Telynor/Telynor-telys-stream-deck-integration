# Tely's Stream Deck Integration

Two-part integration for Foundry Virtual Tabletop and Elgato Stream Deck.

- `foundry-module/` runs inside Foundry VTT v14.
- `stream-deck-plugin/` runs inside Stream Deck and hosts the local bridge.

The bridge listens only on `127.0.0.1`. Each Foundry user pairs their own browser
with their own Stream Deck plugin and retains their normal Foundry permissions.

## Current actions

- Open an Actor, Item, Journal Entry, or Roll Table
- Run a Macro
- Select or target a Token
- Switch Foundry sidebar tabs
- Call actions registered by another module
- Star Rail adapter actions for HSR Hub, missions, GM panel, Aha Instant, and
  character ultimates

## Installation for development

### Foundry

Copy `foundry-module` into Foundry's `Data/modules/telys-stream-deck-integration`
directory, then enable **Tely's Stream Deck Integration** in the world.

### Stream Deck

1. Install Node.js 20 or newer.
2. In `stream-deck-plugin`, run `npm install` and `npm run build`.
3. Link or copy `com.telynor.foundry-integration.sdPlugin` into Stream Deck's
   Plugins directory.
4. Restart Stream Deck.

Use the same pairing secret in Foundry's module settings and on each configured
Stream Deck key. The default local port is `17321`.

## Registration API

Other Foundry modules can add actions without changing the Stream Deck plugin:

```js
Hooks.once("telysStreamDeckReady", (api) => {
  api.registerAction({
    id: "my-module.do-thing",
    name: "Do Thing",
    group: "My Module",
    icon: "icons/svg/lightning.svg",
    permission: (user) => user.active,
    execute: async ({ payload }) => doThing(payload)
  });
});
```

The action appears in the Stream Deck property inspector after Foundry connects.

