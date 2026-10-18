import { FalkorDB } from "falkordb";

export const GRAPH_NAME = process.env.GRAPH_NAME ?? "redstring";

export async function connect() {
  const url = process.env.FALKORDB_URL;
  const db = await FalkorDB.connect(
    url
      ? { url }
      : {
          socket: {
            host: process.env.FALKORDB_HOST ?? "localhost",
            port: Number(process.env.FALKORDB_PORT ?? 6379),
          },
        }
  );
  return { db, graph: db.selectGraph(GRAPH_NAME) };
}

export type Graph = Awaited<ReturnType<typeof connect>>["graph"];
