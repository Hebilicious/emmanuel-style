# emmanuel-style

Emmanuel's landing page.

## Build Setup

```bash
# install dependencies
$ yarn install

# serve with hot reload at localhost:3000
$ yarn dev

# build for production and launch server
$ yarn build
$ yarn start

# generate static project
$ yarn generate
```

### Themes

```bash
black: #000000;
darktheme: #1B1C31;
grey: #C6C6C6;
beige: #FDFAF5;
darkbeige: #FEF1E0;
golden: #FFE5C4;
lightpink: #F4BED8;
vividpink: #FF8DD5;
darkpink: #FF7699;
ultramarine: #7887FE;
lightblue: #21BFFE;
lightgreen: #91D7D9;
green: #6DD5BE;

*profile box shadow*
box-shadow: -10px 15px 30px 0 rgba(0,0,0,0.13);

*article box shadow*
box-shadow: -1px -1px 30px 0 rgba(136, 136, 136, 0.11), -1px, -1px, 30px, 0 rgba(49,49,49,0.9);
height: 75px;
width: 280px;

*linear gradient*
background: linear-gradient(28deg, #FEF1E0 0%, #F4BED8 50%, #B2F2E4 100%);
```

For detailed explanation on how things work, check out [Nuxt.js docs](https://nuxtjs.org).

```js
const meta = [
    // Twitter Card
    { name: "twitter:card", content: "summary" },
    { name: "twitter:title", content: "Vue Social Cards Example" },
    { name: "twitter:description", content: "Vue sample site showing off Twitter and Facebook Cards." },
    // image must be an absolute path
    { name: "twitter:image", content: this.logo },
    // Facebook OpenGraph
    { property: "og:title", content: "Vue Social Cards Example" },
    { property: "og:site_name", content: "Vue Example" },
    { property: "og:type", content: "website" },
    { property: "og:image", content: this.logo },
    { property: "og:description", content: "Vue sample site showing off Twitter and Facebook Cards." }
]
```

Safari specific things :

-   bug with vh and 100% childrens
-   doesn't support webp images
-   doesn't support flex gap
