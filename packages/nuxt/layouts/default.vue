<template>
  <VitePwaManifest />
  <slot />
</template>
<style lang="postcss">
/* Force landscape hack */
@media screen and
    (min-width: 320px) and (max-width: 900px) and (orientation: landscape) {
  html {
    transform: rotate(-90deg);
    transform-origin: left top;
    width: 100vh;
    overflow-x: hidden;
    position: absolute;
    top: 100%;
    left: 0;
  }
}
</style>
