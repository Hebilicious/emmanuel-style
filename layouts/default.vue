<template>
    <div>
        <Nuxt />
    </div>
</template>
<style>
html,
body {
    font-family: "Dosis", sans-serif;
    height: 100%;
}

input,
textarea,
button,
select,
a {
    -webkit-tap-highlight-color: rgba(0, 0, 0, 0);
}

@media screen and (orientation: landscape) {
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

:root {
    --black: #000000;
    --white: #ffffff;
    --darkTheme: #1b1c31;
    --grey: #c6c6c6;
    --beige: #fdfaf5;
    --darkBeige: #fef1e0;
    --golden: #ffe5c4;
    --lightPink: #f4bed8;
    --vividPink: #ff8dd5;
    --darkPink: #ff7699;
    --ultraMarine: #7887fe;
    --lightBlue: #21bffe;
    --indigo: #b2f2e4;
    --lightGreen: #91d7d9;
    --green: #6dd5be;
}

.PinkTheme {
    --primaryBackground: linear-gradient(28deg, #fef1e0 0%, #f4bed8 50%, #b2f2e4 100%);
    --navbarColor: var(--indigo);
    --primaryText: var(--black);
    --colorAccent: var(--black);
    --secondaryAccent: var(--grey);
    --activeBorder: var(--lightGreen);
}

.PaperTheme {
    --primaryBackground: var(--darkBeige);
    --navbarColor: var(--primaryBackground);
    --primaryText: var(--black);
    --colorAccent: var(--grey);
    --secondaryAccent: var(--grey);
    --activeBorder: var(--darkTheme);
}

.LightTheme {
    --primaryBackground: var(--beige);
    --navbarColor: var(--beige);
    --primaryText: var(--black);
    --colorAccent: var(--grey);
    --secondaryAccent: var(--grey);
    --activeBorder: var(--darkTheme);
}

.DarkTheme {
    --primaryBackground: var(--darkTheme);
    --navbarColor: var(--primaryBackground);
    --primaryText: var(--white);
    --colorAccent: var(--darkPink);
    --secondaryAccent: var(--grey);
    --activeBorder: var(--lightGreen);
}
</style>
