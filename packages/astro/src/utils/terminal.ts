/**
 * The site terminal.
 *
 * Navigation here is keyboard only, so the prompt is the primary way around.
 * It speaks the tools a developer already reaches for rather than a bespoke
 * command set:
 *
 *   cd <dir>      change directory (no argument prints the working directory)
 *   ls [path]     list a directory
 *   cat <file>    print an article's markdown, or a repository's record
 *   grep <pat>    search article text, titles, descriptions, tags and repos
 *   open [path]   open the page for a path, or a repository's GitHub page
 *   pwd           print the working directory
 *   theme, help, clear
 *
 * Everything is served from the build-time index inlined in the document, so
 * none of it needs the network and all of it works offline.
 *
 * The prompt is bound on `astro:page-load` because the router replaces the body.
 */
import { go } from "./navigation"
import { pageReady } from "./pageReady"

interface IndexArticle {
	slug: string
	path: string
	href: string
	title: string
	description: string
	tags: string[]
	date: string
	body: string
}

interface IndexRepository {
	name: string
	path: string
	href: string
	description: string
	language: string
	archived: boolean
	homepage: string | null
	category: string
}

interface CommandIndex {
	root: string
	tree: Record<string, { description: string; href: string }>
	articles: IndexArticle[]
	repositories: IndexRepository[]
}

const HELP = [
	"cd <dir>       open a section          ls [dir]    list a directory",
	"cat <file>     print a file            grep <pat>  search everything",
	"open [path]    open a page or repo     pwd         print working dir",
	"theme [l|d]    switch theme            clear       clear output",
	"Ctrl+` or / opens this · Esc closes · Tab completes · j k move, Enter follows"
].join("\n")

const EMPTY: CommandIndex = { root: "/", tree: {}, articles: [], repositories: [] }

const readIndex = (): CommandIndex => {
	const node = document.getElementById("command-index")
	if (!node?.textContent) return EMPTY
	try {
		return JSON.parse(node.textContent) as CommandIndex
	} catch {
		return EMPTY
	}
}

/** Normalise a path against the working directory, the way a shell would. */
const resolve = (cwd: string, target: string): string => {
	if (!target) return cwd
	const base = target.startsWith("/") ? [] : cwd.split("/").filter(Boolean)
	for (const part of target.split("/")) {
		if (part === "" || part === ".") continue
		if (part === "..") base.pop()
		else base.push(part)
	}
	return `/${base.join("/")}`
}

export const createTerminal = () => {
	pageReady((signal) => {
		const root = document.querySelector<HTMLElement>("[data-terminal]")
		const form = document.querySelector<HTMLFormElement>("[data-terminal-form]")
		const input = document.querySelector<HTMLInputElement>("[data-terminal-input]")
		const out = document.querySelector<HTMLElement>("[data-terminal-out]")
		const list = document.querySelector<HTMLElement>("[data-terminal-matches]")

		if (!root || !form || !input || !out || !list) return

		const index = readIndex()
		let cwd = "/"
		let matches: string[] = []
		let active = 0

		const print = (text: string) => {
			out.textContent = text
		}

		const setTheme = (value?: string) => {
			const next =
				value === "light" || value === "dark"
					? value
					: document.documentElement.classList.contains("DarkTheme")
						? "light"
						: "dark"
			document.documentElement.classList.remove("LightTheme", "DarkTheme")
			document.documentElement.classList.add(next === "dark" ? "DarkTheme" : "LightTheme")
			try {
				localStorage.setItem("vueuse-color-scheme", next)
			} catch {
				// Storage can be unavailable; the class above is what matters.
			}
			print(`theme → ${next}`)
		}

		/**
		 * The file system the prompt navigates.
		 *
		 * Directories are the site's sections; files are articles and repository
		 * records. Every entry carries the URL it opens, so `open` is a lookup
		 * rather than a second command set.
		 */
		const dirs = (): string[] => Object.keys(index.tree)
		const entriesOf = (dir: string) => {
			const clean = dir.replace(/^\/|\/$/g, "")
			if (clean === "") return dirs()
			if (clean === "blog") return index.articles.map((a) => `${a.slug}.md`)
			if (clean === "library") return index.repositories.map((r) => `${r.name}.txt`)
			return []
		}

		const findArticle = (target: string) => {
			const name = target.split("/").pop() ?? target
			const slug = name.replace(/\.md$/, "")
			return index.articles.find((a) => a.slug === slug)
		}
		const findRepo = (target: string) => {
			const name = target.split("/").pop() ?? target
			return index.repositories.find((r) => r.name === name.replace(/\.txt$/, ""))
		}

		const isDir = (target: string) => {
			const clean = resolve(cwd, target).replace(/^\/|\/$/g, "")
			return clean === "" || dirs().includes(clean)
		}

		/** `ls` prints names the way `ls` does: one per line, sorted. */
		const cmdLs = (arg: string) => {
			const target = arg || cwd
			const clean = resolve(cwd, target).replace(/^\/|\/$/g, "")
			if (!isDir(target)) {
				print(`ls: ${target}: not a directory`)
				return
			}
			const names = entriesOf(clean)
			if (names.length === 0) return
			print(
				names
					.sort((a, b) => a.localeCompare(b))
					.map((name) => `  ${name}`)
					.join("\n")
			)
		}

		/** `cat` prints an article's markdown, or a repository's record. */
		const cmdCat = (arg: string) => {
			if (!arg) {
				print("cat: missing operand")
				return
			}
			const article = findArticle(arg)
			if (article) {
				print(
					[
						`# ${article.title}`,
						`${article.date}  ·  ${article.tags.map((t) => `#${t}`).join(" ")}`,
						"",
						article.body.trim()
					].join("\n")
				)
				return
			}
			const repo = findRepo(arg)
			if (repo) {
				print(
					[
						`${repo.name}`,
						`${repo.language}${repo.archived ? "  ·  archived" : ""}`,
						"",
						repo.description,
						repo.homepage ? `\nhomepage: ${repo.homepage}` : "",
						`source:   ${repo.href}`
					]
						.filter(Boolean)
						.join("\n")
				)
				return
			}
			print(`cat: ${arg}: no such file`)
		}

		/** `grep` searches everything: bodies, titles, descriptions, tags, repos. */
		const cmdGrep = (args: string[]) => {
			const onlyNames = args.includes("-l")
			const terms = args.filter((a) => !a.startsWith("-"))
			const pattern = terms.join(" ")
			if (!pattern) {
				print("usage: grep [-l] <pattern>")
				return
			}

			let re: RegExp
			try {
				re = new RegExp(pattern, "i")
			} catch {
				print(`grep: ${pattern}: invalid pattern`)
				return
			}

			const hits: string[] = []
			for (const article of index.articles) {
				const haystack = [
					article.title,
					article.description,
					article.tags.join(" "),
					article.body
				].join("\n")
				if (!re.test(haystack)) continue
				if (onlyNames) {
					hits.push(article.path)
					continue
				}
				// Print the matching lines with their file, which is what grep does.
				const lines = haystack.split("\n")
				const found = lines
					.map((line, i) => ({ line, i }))
					.filter(({ line }) => re.test(line))
					.slice(0, 3)
				hits.push(
					found
						.map(({ line, i }) => `${article.path}:${i + 1}: ${line.trim().slice(0, 110)}`)
						.join("\n")
				)
			}
			for (const repo of index.repositories) {
				const haystack = `${repo.name} ${repo.description} ${repo.language} ${repo.category}`
				if (!re.test(haystack)) continue
				if (onlyNames) hits.push(repo.path)
				else hits.push(`${repo.path}: ${repo.description}`)
			}

			print(hits.length > 0 ? hits.join("\n") : `grep: ${pattern}: no matches`)
		}

		/**
		 * `cd` moves the working directory and follows it.
		 *
		 * Changing directory without showing anything made `cd blog` look like a
		 * no-op, so a directory is also a page and `cd` opens it. `cd /` alone
		 * only reports the working directory, and bare `cd` is `pwd`.
		 */
		const cmdCd = (arg: string) => {
			if (!arg) {
				print(cwd)
				return
			}
			if (!isDir(arg)) {
				print(`cd: ${arg}: not a directory`)
				return
			}
			cwd = resolve(cwd, arg)
			if (cwd === "/" || cwd === "") {
				cwd = "/"
				print("→ /")
				go("/")
				return
			}
			const name = cwd.replace(/^\//, "")
			const page = index.tree[name]
			if (page) {
				print(`→ ${page.href}`)
				go(page.href)
				return
			}
			print(cwd)
		}

		/** `open` is the bridge from the file system to the site. */
		const cmdOpen = (arg: string) => {
			const target = arg || cwd
			if (!arg) print(`open ${cwd}  (give a path to open something else)`)
			const article = findArticle(target)
			if (article) {
				print(`→ ${article.href}`)
				go(article.href)
				return
			}
			const repo = findRepo(target)
			if (repo) {
				window.open(repo.href, "_blank", "noopener,noreferrer")
				print(`opened ${repo.href} in a new tab`)
				return
			}
			const clean = resolve(cwd, target).replace(/^\/|\/$/g, "")
			const dir = clean === "" ? "home" : clean
			const page = index.tree[dir]
			if (page) {
				print(`→ ${page.href}`)
				go(page.href)
				return
			}
			print(`open: ${target}: nothing to open`)
		}

		/** Everything the prompt can be asked to do, for completion and dispatch. */
		const COMMANDS = ["cd", "ls", "cat", "grep", "open", "pwd", "theme", "help", "clear"]

		/**
		 * Completion candidates for a partial line.
		 *
		 * First word completes commands; later words complete paths, and the path
		 * set depends on the command: `cat` and `open` want files, `cd` and `ls`
		 * want directories.
		 */
		const completions = (line: string): string[] => {
			const parts = line.split(/\s+/)
			const head = parts[0] ?? ""
			const last = parts[parts.length - 1] ?? ""

			if (parts.length === 1 && !line.endsWith(" ")) {
				return COMMANDS.filter((c) => c.startsWith(head))
			}

			const command = head
			const pool: string[] = []
			if (command === "cd" || command === "ls") {
				pool.push(...dirs())
				if (last.includes("/")) pool.push(...entriesOf(last.split("/")[0]))
			} else if (command === "cat" || command === "open") {
				pool.push(
					...dirs(),
					...index.articles.map((a) => a.path.replace(/^blog\//, "")),
					...index.repositories.map((r) => r.path.replace(/^library\//, ""))
				)
			} else if (command === "theme") {
				pool.push("light", "dark")
			}

			return pool.filter((item) => item.startsWith(last)).slice(0, 8)
		}

		const paint = () => {
			list.replaceChildren()
			for (const [i, match] of matches.entries()) {
				const li = document.createElement("li")
				li.className = "Match"
				li.dataset.active = String(i === active)
				li.textContent = match
				list.append(li)
			}
		}

		const run = (line: string) => {
			const [head, ...rest] = line.trim().split(/\s+/)
			const arg = rest.join(" ")

			switch (head) {
				case "cd":
					cmdCd(arg)
					return
				case "ls":
					cmdLs(arg)
					return
				case "cat":
					cmdCat(arg)
					return
				case "grep":
					cmdGrep(rest)
					return
				case "open":
					cmdOpen(arg)
					return
				case "pwd":
					print(cwd)
					return
				case "theme":
					setTheme(arg)
					return
				case "help":
					print(HELP)
					return
				case "clear":
					print("")
					return
				default:
					print(`${head}: command not found. Try help.`)
			}
		}

		/**
		 * Command history, walked with Up and Down the way a shell does.
		 *
		 * `cursor` is an index into `history`, and -1 means "the line being
		 * typed", so pressing Down at the newest entry returns to an empty prompt
		 * rather than sticking on the last command.
		 */
		let history: string[] = []
		let cursor = -1
		let draft = ""

		const recall = (delta: number) => {
			if (history.length === 0) return
			if (cursor === -1) draft = input.value

			const next = cursor + delta
			if (next < -1) return

			if (next >= history.length) {
				cursor = -1
				input.value = draft
			} else {
				cursor = next
				input.value = history[cursor]
			}

			// The caret belongs at the end, as in a shell.
			input.setSelectionRange(input.value.length, input.value.length)
			matches = []
			paint()
		}

		const submit = (raw: string) => {
			const line = raw.trim()
			if (!line) return
			history = [line, ...history.filter((entry) => entry !== line)].slice(0, 100)
			cursor = -1
			draft = ""
			run(line)
			input.value = ""
			matches = []
			paint()
		}

		const setOpen = (next: boolean) => {
			root.hidden = !next
			try {
				sessionStorage.setItem("terminal-open", next ? "1" : "0")
			} catch {
				// Storage can be unavailable; the prompt still works for this page.
			}
			if (next) input.focus()
		}

		const isOpen = () => !root.hidden

		// Completion is recomputed on every keystroke, but it only ever grows
		// the list above the prompt, which is why the prompt itself stays put.
		input.addEventListener(
			"input",
			() => {
				matches = completions(input.value)
				active = 0
				paint()
			},
			{ signal }
		)

		input.addEventListener(
			"keydown",
			(event) => {
				if (event.key === "Tab") {
					event.preventDefault()
					if (matches.length > 0) {
						const parts = input.value.split(/\s+/)
						// Complete the word being typed, keeping earlier words.
						if (parts.length === 1 && !input.value.endsWith(" ")) {
							input.value = matches[active]
						} else {
							parts[parts.length - 1] = matches[active]
							input.value = parts.join(" ")
						}
						matches = completions(input.value)
						paint()
					}
					return
				}
				// Up and Down walk the command history, as in any shell.
				if (event.key === "ArrowUp") {
					event.preventDefault()
					recall(1)
					return
				}
				if (event.key === "ArrowDown") {
					event.preventDefault()
					recall(-1)
					return
				}
				// Ctrl+n and Ctrl+p cycle the completion list instead.
				if (event.key === "n" && event.ctrlKey && matches.length > 0) {
					event.preventDefault()
					active = (active + 1) % matches.length
					paint()
					return
				}
				if (event.key === "p" && event.ctrlKey && matches.length > 0) {
					event.preventDefault()
					active = (active - 1 + matches.length) % matches.length
					paint()
				}
			},
			{ signal }
		)

		form.addEventListener(
			"submit",
			(event) => {
				event.preventDefault()
				submit(input.value)
			},
			{ signal }
		)

		/*
		 * The terminal keeps only its own switch.
		 *
		 * Every other shortcut lives in utils/cursor.ts, which owns the keyboard
		 * while the prompt is closed. Splitting them across modules is what
		 * previously armed a prefix in one closure and delivered the suffix to
		 * another. Ctrl+` is safe here: no browser binds it.
		 */
		document.addEventListener(
			"keydown",
			(event) => {
				if (event.key === "`" && event.ctrlKey) {
					event.preventDefault()
					setOpen(!isOpen())
					return
				}
				if (event.key === "Escape" && isOpen()) {
					event.preventDefault()
					setOpen(false)
				}
			},
			{ signal }
		)

		document.addEventListener(
			"prompt:open",
			() => {
				setOpen(true)
				// Focus belongs in the prompt whenever it is open, including right after a
				// navigation, or the shortcuts and the typing both go nowhere.
				requestAnimationFrame(() => input.focus())
			},
			{ signal }
		)

		try {
			if (sessionStorage.getItem("terminal-open") === "1") {
				setOpen(true)
				/*
				 * The prompt survives a navigation, so it takes focus again here.
				 * Without this the keyboard went nowhere after using `cd`, because the
				 * page swap moved focus out of the input.
				 */
				requestAnimationFrame(() => input.focus())
			}
		} catch {
			// Ignore storage failures.
		}
	})
}
