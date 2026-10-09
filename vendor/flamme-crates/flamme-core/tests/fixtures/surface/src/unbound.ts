const graphql = (value: string): string => value

export const notADocument = graphql(`query Local { nope }`)

export const tag = graphql`query AlsoLocal { nope }`
