/**
 * Starting points for the REST tool.
 *
 * Deliberately the endpoints people actually poke from a terminal session:
 * services that are usually only reachable from inside the machine or the
 * private network you are logged into. A template is a *shape*, not a saved
 * request — the user edits it and can save their own copy later.
 *
 * Everything here is plain data so the renderer can render the list without a
 * round trip, and so the same catalog can be asserted in a probe.
 */
import type { RestRequest } from './types'

export interface RestTemplate {
  id: string
  /** Short name, shown in the menu. */
  name: string
  /** One line saying what it is for, so the list is usable without trying them. */
  description: string
  request: RestRequest
}

const json = (): Array<{ name: string; value: string }> => [
  { name: 'Content-Type', value: 'application/json' }
]

export const REST_TEMPLATES: RestTemplate[] = [
  {
    id: 'ollama-tags',
    name: 'Ollama · list models',
    description: 'Local Ollama: which models are pulled',
    request: { method: 'GET', url: 'http://127.0.0.1:11434/api/tags', headers: [] }
  },
  {
    id: 'ollama-generate',
    name: 'Ollama · generate',
    description: 'Local Ollama: one non-streamed completion',
    request: {
      method: 'POST',
      url: 'http://127.0.0.1:11434/api/generate',
      headers: json(),
      body: '{\n  "model": "llama3",\n  "prompt": "Hello",\n  "stream": false\n}'
    }
  },
  {
    id: 'elasticsearch-health',
    name: 'Elasticsearch · health',
    description: 'Cluster health, the usual first question',
    request: { method: 'GET', url: 'http://127.0.0.1:9200/_cluster/health', headers: [] }
  },
  {
    id: 'prometheus-query',
    name: 'Prometheus · query',
    description: 'Instant query over the HTTP API',
    request: {
      method: 'GET',
      url: 'http://127.0.0.1:9090/api/v1/query?query=up',
      headers: []
    }
  },
  {
    id: 'health-check',
    name: 'Health check',
    description: 'A service that answers on /health',
    request: { method: 'GET', url: 'http://127.0.0.1:8080/health', headers: [] }
  },
  {
    id: 'github-repo',
    name: 'GitHub · repository',
    description: 'Public JSON API, useful for checking outbound access',
    request: {
      method: 'GET',
      url: 'https://api.github.com/repos/electron/electron',
      headers: [{ name: 'Accept', value: 'application/vnd.github+json' }]
    }
  },
  {
    id: 'jsonplaceholder-post',
    name: 'JSONPlaceholder · POST',
    description: 'Echoes a JSON body back, no auth required',
    request: {
      method: 'POST',
      url: 'https://jsonplaceholder.typicode.com/posts',
      headers: json(),
      body: '{\n  "title": "TermDeck",\n  "body": "hello",\n  "userId": 1\n}'
    }
  }
]

export function templateById(id: string): RestTemplate | undefined {
  return REST_TEMPLATES.find((template) => template.id === id)
}
