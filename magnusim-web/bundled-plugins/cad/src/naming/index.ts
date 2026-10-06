// The naming layer (proposal §4.5): face names after every operation, stored
// references and their resolution. Pure functions over kernel results.
// Owner: DOC-CORE (naming layer). docs/p2p3-plan.md §3.6 says who calls what.
// SPDX-License-Identifier: GPL-3.0-or-later
export { describeFace, edgeName, faceName, indexedNames, mergeNames, namesAfter, placeWords, splitMerged, splitSuffix, vertexName, type FaceRole } from './names';
export { faceSignature, nameCandidates, resolveFace, sameKind, signatureDistance } from './resolve';
export { refOfFace, kernelLookup } from './refs';
export { namesFromResult } from './result';
export { edgeSignature, edgesOfFace, edgeWords, faceShortWords, refOfEdge, refOfVertex, resolveEdge, resolveVertex, splitEdgeName, splitVertexName, vertexSignature, vertexWords } from './edges';
