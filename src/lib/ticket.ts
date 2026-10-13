/**
 * The ticket as the session reads it: the issue, its human comments, and the
 * documents those link to, downloaded and made readable (ticketdocs.ts).
 */
import { getIssue, allIssueNotes, type IssueNote } from './gitlab.js';
import { collectTicketDocs } from './ticketdocs.js';
import { log } from './log.js';

export interface TicketDoc {
  name: string;
  /** "description" or "comment N", numbered as the prompt numbers comments. */
  where: string;
  /** Absolute path of the downloaded original. Absent when the download failed. */
  path?: string;
  /** A plain-text extraction, for formats the Read tool cannot open itself. */
  textPath?: string;
  /** Why this one could not be downloaded or converted. */
  error?: string;
}

export interface Ticket {
  iid: number;
  title: string;
  description: string | null;
  labels: string[];
  /** Human comments, oldest first: what ticketComments() keeps. */
  notes: string[];
  /** Files attached in the description or a comment, downloaded to the run dir. */
  documents: TicketDoc[];
  /** Document links that point outside GitLab (Google Docs, SharePoint, …). */
  externalDocs: Array<{ url: string; where: string }>;
}

/**
 * Any note this pipeline wrote, by its hidden `<!-- oneshot:… -->` marker.
 *
 * GitLab's `system` flag does not cover these: they are ordinary comments posted
 * through the API, as whoever owns the desk's token. Matching the marker rather
 * than the prose, and any marker rather than a list of kinds, keeps this true
 * for every note type — including the ones the multi-phase Oneshot left on
 * tickets still on the board.
 */
export function isMachineNote(body: string | null | undefined): boolean {
  return /<!--\s*oneshot:/i.test(body ?? '');
}

/**
 * Every human comment and unbounded: requirements are amended and documents
 * attached anywhere in a thread, and a window drops them silently. GitLab's
 * system notes (label swaps, assignments, "mentioned in") are not comments and
 * would only crowd the prompt. This system's own notes are dropped too — by
 * marker, and by the older 'Oneshot ' prefix — because feeding its own notes
 * back in as ticket requirements is how a session ends up working on a summary
 * of itself.
 */
export function ticketComments(notes: IssueNote[]): string[] {
  return notes
    .filter((n) => !n.system && n.body && !isMachineNote(n.body) && !n.body.startsWith('Oneshot '))
    .map((n) => n.body);
}

/** The ticket, or null when GitLab will not give the issue. Comments and documents are best effort. */
export async function fetchTicket(iid: number): Promise<Ticket | null> {
  const res = await getIssue(iid);
  if (!res.ok || !res.data) return null;
  const notes = await allIssueNotes(iid);
  if (!notes.ok) log.warn(`#${iid}: could not read the ticket's comments; the session sees the description only`, { error: notes.error });
  const comments = notes.ok && notes.data ? ticketComments(notes.data) : [];
  const docs = await collectTicketDocs(iid, [
    { where: 'description', body: res.data.description ?? '' },
    ...comments.map((body, i) => ({ where: `comment ${i + 1}`, body })),
  ]).catch((err: Error) => {
    log.warn(`#${iid}: could not collect the ticket's documents`, { error: err.message });
    return { documents: [], externalDocs: [] };
  });
  return {
    iid: res.data.iid,
    title: res.data.title,
    description: res.data.description,
    labels: res.data.labels,
    notes: comments,
    documents: docs.documents,
    externalDocs: docs.externalDocs,
  };
}
