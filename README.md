# Nuxt 3 Minimal Starter

Look at the [Nuxt 3 documentation](https://nuxt.com/docs/getting-started/introduction) to learn more.

## PWA

```html
<ClientOnly>
    <div v-if="$pwa?.offlineReady || $pwa?.needRefresh" class="pwa-toast" role="alert">
        <div class="message">
            <span v-if="$pwa.offlineReady"> App ready to work offline </span>
            <span v-else> New content available, click on reload button to update. </span>
        </div>
        <button v-if="$pwa.needRefresh" @click="$pwa.updateServiceWorker()">Reload</button>
        <button @click="$pwa.cancelPrompt()">Close</button>
    </div>
    <div v-if="$pwa?.showInstallPrompt && !$pwa?.offlineReady && !$pwa?.needRefresh" class="pwa-toast" role="alert">
        <div class="message">
            <span> Install PWA </span>
        </div>
        <button @click="$pwa.install()">Install</button>
        <button @click="$pwa.cancelInstall()">Cancel</button>
    </div>
</ClientOnly>
```

## Setup

Make sure to install the dependencies:

```bash
# yarn
yarn install

# npm
npm install

# pnpm
pnpm install
```

## Development Server

Start the development server on `http://localhost:3000`

```bash
npm run dev
```

## Production

Build the application for production:

```bash
npm run build
```

Locally preview production build:

```bash
npm run preview
```

Check out the [deployment documentation](https://nuxt.com/docs/getting-started/deployment) for more information.
