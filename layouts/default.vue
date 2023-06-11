<template>
    <VitePwaManifest />
    <slot />
</template>
<style lang="postcss">
@custom-media --mLandscape (screen and (min-width: 320px) and (max-width: 900px) and (orientation: landscape));

/* Force landscape hack */
@media (--mLandscape) {
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
