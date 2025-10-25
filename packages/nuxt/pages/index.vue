<script lang="ts" setup>
import type { Theme } from "~/composables/useTheme"

defineOptions({ name: "Index" })

const iconHeight = "1.5rem"
const isReady = ref(false)

const { mode, themesList, rootRef } = useTheme()

onMounted(() => {
	isReady.value = true
})

// Rainbow text
const SideName = computed(() => {
	return {
		SideName: true,
		PaperSideName: themesList.get(mode.value as Theme) === "PaperTheme"
	}
})
</script>
<template>
  <div>
    <div v-show="isReady" id="rootId" ref="rootRef" class="Root">
      <div class="Top">
        <div class="PageContainer">
          <div class="Landing">
            <div class="ContentWrapper">
              <div class="Content">
                <div class="Heading">
                  <nuxt-picture
                    src="/Profile.png"
                    width="100"
                    height="100"
                    provider="imagekit"
                  />
                </div>
                <div class="Name">
                  <h2>Emmanuel LD</h2>
                </div>
                <div class="Logos">
                  <div class="Icons">
                    <ExternalLink
                      label="twitter"
                      url="twitter.com/its_hebilicious">
                      <Twitter :icon-height="iconHeight" />
                    </ExternalLink>
                    <ExternalLink label="github" url="github.com/Hebilicious">
                      <Github :icon-height="iconHeight" />
                    </ExternalLink>
                    <ExternalLink
                      label="linkedIn"
                      url="www.linkedin.com/in/emmanuel-donnet">
                      <LinkedIn :icon-height="iconHeight" />
                    </ExternalLink>
                  </div>
                </div>
                <div class="MainText">
                  <div>Digital Nomad.</div>
                  <div>Computer things.</div>
                </div>
                <Quotes />
              </div>
              <div :class="SideName">
                <h1>
                  <span>E</span>
                  <span>m</span>
                  <span>m</span>
                  <span>a</span>
                  <span>n</span>
                  <span>u</span>
                  <span>e</span>
                  <span>l</span>
                </h1>
              </div>
            </div>
            <div class="Separation">
              <div></div>
              <div class="FakeLine"></div>
            </div>
          </div>
        </div>
        <!-- <div class="PageContainer"></div> -->
        <!-- <div class="PageContainer"></div> -->
        <!-- <div class="PageContainer"></div> -->
        <!-- <div class="PageContainer"></div> -->
      </div>
      <div class="Bottom">
        <ClientOnly>
          <div class="ThemeSwitcher">
            <ThemeButton v-for="theme of themesList" :key="theme[0]" :theme />
          </div>
        </ClientOnly>
      </div>
    </div>
  </div>
</template>

<style lang="postcss">
.Root {
  /* Force landscape hack */
  @media screen and
      (min-width: 320px) and (max-width: 900px) and (orientation: landscape) {
    height: 100vmax !important;
  }

  display: grid;
  grid-template-rows: 1fr 5rem;
  position: relative;
  height: 100vh;
  width: 100%;
  max-width: 100%;
  background: var(--primaryBackground);
  color: var(--primaryText);
  transition: background 1s ease;

  .Top {
    @apply grid h-auto overflow-y-auto;

    scrollbar-width: thin;
    scrollbar-color: var(--activeBorder) transparent;
    &::-webkit-scrollbar {
      width: 12px;
    }
    &::-webkit-scrollbar-track {
      background: transparent;
    }
    &::-webkit-scrollbar-thumb {
      background-color: var(--activeBorder);
      border-radius: 20px;
      border: 3px solid transparent;
    }
  }

  .Bottom {
    @apply grid pl-8;

    align-items: center;
  }
}

.PageContainer {
  display: grid;
  position: relative;
  min-height: calc(100vh - 5rem);
  width: 100%;
  max-width: 100%;
}

.Landing {
  @apply grid gap-2 h-auto;
}

.ContentWrapper {
  @apply grid pl-8;

  grid-template-columns: 1fr 2rem;
}

.SideName {
  display: grid;
  place-items: center;
  position: relative;
  overflow: hidden;
  transition: color 0.5s ease-in-out;

  h1 {
    @apply text-4xl;

    position: absolute;
    transform: rotate(180deg);
    writing-mode: vertical-rl;
    font-family: Aclonica, sans-serif;
    text-transform: uppercase;
    color: var(--giantText);
  }

  &.PaperSideName {
    h1 {
      span {
        color: black;
        transition: color 0.5s ease-in-out;
        &:nth-child(1) {
          color: var(--ultraMarine);
        }
        &:nth-child(2) {
          color: var(--lightBlue);
        }
        &:nth-child(3) {
          color: var(--lightGreen);
        }
        &:nth-child(4) {
          color: var(--darkBeige);
        }
        &:nth-child(5) {
          color: var(--golden);
        }
        &:nth-child(6) {
          color: var(--lightPink);
        }
        &:nth-child(7) {
          color: var(--vividPink);
        }
        &:nth-child(8) {
          color: var(--green);
        }
      }
    }
  }
}

.Content {
  @apply grid gap-4 pt-24;
  @media screen and
      (min-width: 320px) and (max-width: 900px) and (orientation: landscape) {
    @apply pt-8;
  }
}

.Heading {
  display: grid;
  align-items: center;
  img {
    height: 5rem;
    width: auto;
    border-radius: 100%;
    object-fit: contain;
    box-shadow: -10px 15px 30px 0 rgba(0, 0, 0, 0.13);
  }
}

.Name {
  @apply text-3xl font-bold;
}

.SubText {
  @apply text-sm italic;
}

.Separation {
  --height: 3px;

  display: grid;
  grid-template-columns: 60% auto;
  height: var(--height);
  width: 100%;
  .FakeLine {
    background: var(--activeBorder) no-repeat center/100% var(--height);
  }
}

.Icons {
  @apply flex justify-between;

  width: 50vmin;
}

.ThemeSwitcher {
  @apply grid grid-flow-col;

  width: 70vmin;
  place-items: center;
}
</style>
