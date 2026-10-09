/**
 * The browser entry: the fixture endpoint, the app, and the mount.
 *
 * The transport is the example's own fixture, so the app runs with no server. Swap that one line for
 * `createFetchTransport({ url: '/graphql' })` (or pass any `TransportFn`) and this is a real app.
 */
import { createApp as createVueApp } from 'vue';

import Root from './App.vue';
import { createApp } from './app.js';
import { createFixtureServer } from './fixture.js';

const fixture = createFixtureServer();
const app = createApp({
  transport: fixture.transport,
  online: () => navigator.onLine,
});

await app.ready;

createVueApp(Root).use(app.plugin).mount('#app');
