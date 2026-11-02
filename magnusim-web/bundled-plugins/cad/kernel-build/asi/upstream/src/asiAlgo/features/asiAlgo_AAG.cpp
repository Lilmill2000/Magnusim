//-----------------------------------------------------------------------------
// Created on: 26 February 2016
//-----------------------------------------------------------------------------
// Copyright (c) 2017, Sergey Slyadnev
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
//    * Redistributions of source code must retain the above copyright
//      notice, this list of conditions and the following disclaimer.
//    * Redistributions in binary form must reproduce the above copyright
//      notice, this list of conditions and the following disclaimer in the
//      documentation and/or other materials provided with the distribution.
//    * Neither the name of the copyright holder(s) nor the
//      names of all contributors may be used to endorse or promote products
//      derived from this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
// ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
// WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL THE AUTHORS OR CONTRIBUTORS BE LIABLE FOR ANY
// DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
// (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
// LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
// ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
// SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
//-----------------------------------------------------------------------------

// Own include
#include <asiAlgo_AAG.h>

// asiAlgo includes
#include <asiAlgo_AAGIterator.h>
#include <asiAlgo_FeatureAttrAngle.h>
#include <asiAlgo_FeatureAttrFace.h>
#include <asiAlgo_JSON.h>

// OCCT includes
#include <OSD_FileSystem.hxx>
#include <OSD_OpenFile.hxx>
#include <ShapeAnalysis_Edge.hxx>
#include <Standard_ReadLineBuffer.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>

//-----------------------------------------------------------------------------

#define NODE_ATTR_BEGIN "NODE_ATTR_BEGIN"
#define ARC_ATTR_BEGIN  "ARC_ATTR_BEGIN"

//-----------------------------------------------------------------------------

namespace
{
  //! Returns the dihedral angle type for the given arc.
  //! \param[in] fx   the 1-based ID of a face being collapsed.
  //! \param[in] nid  the 1-based ID of the neighbor face.
  //! \param[in] pAAG the AAG instance.
  //! \return dihedral angle type.
  asiAlgo_FeatureAngleType GetAngleType(const int    fx,
                                        const int    nid,
                                        asiAlgo_AAG* pAAG)
  {
    // Get dihedral angle for the 1-st neighbor.
    asiAlgo_AAG::t_arc          fxn(fx, nid);
    Handle(asiAlgo_FeatureAttr) fxnAttr;
    asiAlgo_FeatureAngleType    fxnAngle = FeatureAngleType_Undefined;
    //
    if ( pAAG->HasArcAttribute(fxn, fxnAttr) )
    {
      Handle(asiAlgo_FeatureAttrAngle) attrAngle = Handle(asiAlgo_FeatureAttrAngle)::DownCast(fxnAttr);
      fxnAngle = attrAngle->GetAngleType();
    }

    return fxnAngle;
  }
}

//! Some constants we need for binary buffering.
namespace serialize
{
  static const size_t HEADER_SIZE       = 80;
  static const size_t ATTR_SECTION_SIZE = 16;
  static const size_t ATTR_NAME_SIZE    = 64;
}

//-----------------------------------------------------------------------------

asiAlgo_AAG::t_arc_attr_set::t_arc_attr_set(const Handle(asiAlgo_FeatureAttr)& A)
{
  if ( A->IsKind( STANDARD_TYPE(asiAlgo_FeatureAttrAngle) ) )
    this->AngleAttr = Handle(asiAlgo_FeatureAttrAngle)::DownCast(A);
  else
    this->Add(A); // For user-defined attributes.
}

//-----------------------------------------------------------------------------

asiAlgo_AAG::asiAlgo_AAG(const TopoDS_Shape&               masterCAD,
                         const TopTools_IndexedMapOfShape& selectedFaces,
                         const bool                        allowSmooth,
                         const double                      smoothAngularTol,
                         const int                         cachedMaps)
{
  this->init(masterCAD,
             selectedFaces,
             allowSmooth,
             smoothAngularTol,
             cachedMaps);
}

//-----------------------------------------------------------------------------

asiAlgo_AAG::asiAlgo_AAG(const TopoDS_Shape& masterCAD,
                         const bool          allowSmooth,
                         const double        smoothAngularTol,
                         const int           cachedMaps)
{
  this->init(masterCAD,
             TopTools_IndexedMapOfShape(),
             allowSmooth,
             smoothAngularTol,
             cachedMaps);
}

//-----------------------------------------------------------------------------

asiAlgo_AAG::~asiAlgo_AAG()
{
}

//-----------------------------------------------------------------------------

bool asiAlgo_AAG::Serialize(const Handle(asiAlgo_AAG)& aag,
                            const char*                pFilename,
                            ActAPI_ProgressEntry       progress)
{
  FILE* pFile = OSD_OpenFile(pFilename, "wb");
  //
  if ( pFile == NULL )
  {
    progress.SendLogMessage(LogErr(Normal) << "Cannot open file for writing.");
    return false;
  }

  /* =============
   *  Header info.
   * ============= */

  // Serialize header.
  char header[serialize::HEADER_SIZE] = "AAG exported by Analysis Situs";
  if ( fwrite(header, 1, serialize::HEADER_SIZE, pFile) != serialize::HEADER_SIZE )
  {
    progress.SendLogMessage(LogErr(Normal) << "Cannot open file for writing.");
    return false;
  }

  // Format version byte.
  if ( !asiAlgo_Utils::Binary::WriteInt(BinFormat_V1, pFile, true) )
  {
    return false;
  }

  /* ==================================
   *  Adjacency matrix (graph as such).
   * ================================== */

  // Write N as the number of nodes.
  const int N = aag->GetNumberOfNodes();
  //
  if ( !asiAlgo_Utils::Binary::WriteInt(N, pFile, true) )
  {
    return false;
  }

  // Write N times the rows of adjacency matrix.
  //
  // ... <f_k> <j_k - i_k> <a_{k,i_k}> ... <a_{k,j_k}> ...
  //
  // Here <f_k> is the face ID in the k-th row, and a_{k,i} are
  // the adjacency elements, whose number is variable and equal
  // to <j_k - i_k>.
  //
  // E.g.:
  // ... 10 3 1 2 4 ...
  // means that the face `10` has `3` adjacent elements: `1`, `2` and `4`.
  //
  // Each number is a 4-bytes integer.
  const asiAlgo_AdjacencyMx& mx = aag->GetNeighborhood();
  //
  for ( asiAlgo_AdjacencyMx::t_mx::Iterator rowIt(mx.mx);
        rowIt.More(); rowIt.Next() )
  {
    const t_topoId         f_k  = rowIt.Key();
    const asiAlgo_Feature& nids = rowIt.Value();

    // <f_k>: the next face ID whose adjacency row is serialized.
    if ( !asiAlgo_Utils::Binary::WriteInt(f_k, pFile, true) )
    {
      return false;
    }

    // <j_k - i_k>: how many elements are in the adjacency row.
    const int numAdj = nids.Extent();
    //
    if ( !asiAlgo_Utils::Binary::WriteInt(numAdj, pFile, true) )
    {
      return false;
    }

    // Write each of <a_{k,i_k}> elements.
    for ( asiAlgo_Feature::Iterator nit(nids); nit.More(); nit.Next() )
    {
      const int nid = nit.Key();

      if ( !asiAlgo_Utils::Binary::WriteInt(nid, pFile, true) )
      {
        return false;
      }
    }
  }

  /* ==============================
   *  Serializable node attributes.
   * ============================== */

  const t_node_attributes& nodeAttrs = aag->GetNodeAttributes();
  //
  for ( t_node_attributes::Iterator nodeIt(nodeAttrs);
        nodeIt.More(); nodeIt.Next() )
  {
    const int         fid     = nodeIt.Key();
    const t_attr_set& attrSet = nodeIt.Value();
    //
    for ( t_attr_set::Iterator attrIt(attrSet);
          attrIt.More(); attrIt.Next() )
    {
      const Handle(asiAlgo_FeatureAttr)& A        = attrIt.GetAttr();
      std::string                        attrName = A->DynamicType()->Name();

      if ( strlen( attrName.c_str() ) > serialize::ATTR_NAME_SIZE )
      {
        progress.SendLogMessage( LogWarn(Normal) << "Skipping AAG attribute '%1' as its name is too long."
                                                 << attrName );
        continue;
      }

      // Node attribute section.
      char secHeader[serialize::ATTR_SECTION_SIZE] = NODE_ATTR_BEGIN;
      if ( fwrite(secHeader, 1, serialize::ATTR_SECTION_SIZE, pFile) != serialize::ATTR_SECTION_SIZE )
      {
        fclose(pFile);
        return false;
      }

      // Node ID.
      if ( !asiAlgo_Utils::Binary::WriteInt(fid, pFile, true) )
      {
        return false;
      }

      // Attribute type (class name).
      char attrType[serialize::ATTR_NAME_SIZE];
      //
#ifndef WIN32
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wstringop-truncation"
#endif
      strncpy(attrType, attrName.c_str(), serialize::ATTR_NAME_SIZE);
#ifndef WIN32
#pragma GCC diagnostic pop
#endif
      //
      if ( fwrite(attrType, 1, serialize::ATTR_NAME_SIZE, pFile) != serialize::ATTR_NAME_SIZE )
      {
        fclose(pFile);
        return false;
      }

      // Serialize the attribute.
      if ( !A->Serialize(pFile) )
      {
        progress.SendLogMessage( LogWarn(Normal) << "AAG attribute '%1' cannot be serialized."
                                                 << attrName );

        // Put zero size of the buffer.
        if ( !asiAlgo_Utils::Binary::WriteInt(0, pFile, true) )
        {
          return false;
        }
        //
        continue;
      }
    }
  }

  /* =============================
   *  Serializable arc attributes.
   * ============================= */

  const auto& arcAttrs = aag->GetArcAttributes();
  //
  for ( t_arc_attributes::Iterator arcIt(arcAttrs);
        arcIt.More(); arcIt.Next() )
  {
    const t_arc&      arc     = arcIt.Key();
    const t_attr_set& attrSet = arcIt.Value();

    for ( t_attr_set::Iterator attrIt(attrSet);
          attrIt.More(); attrIt.Next() )
    {
      const Handle(asiAlgo_FeatureAttr)& A        = attrIt.GetAttr();
      std::string                        attrName = A->DynamicType()->Name();

      if ( strlen( attrName.c_str() ) > serialize::ATTR_NAME_SIZE )
      {
        progress.SendLogMessage( LogWarn(Normal) << "Skipping AAG attribute '%1' as its name is too long."
                                                 << attrName );
        continue;
      }

      // Node attribute section.
      char secHeader[serialize::ATTR_SECTION_SIZE] = ARC_ATTR_BEGIN;
      if ( fwrite(secHeader, 1, serialize::ATTR_SECTION_SIZE, pFile) != serialize::ATTR_SECTION_SIZE )
      {
        fclose(pFile);
        return false;
      }

      // 1-st node ID.
      if ( !asiAlgo_Utils::Binary::WriteInt(arc.F1, pFile, true) )
      {
        return false;
      }

      // 2-nd node ID.
      if ( !asiAlgo_Utils::Binary::WriteInt(arc.F2, pFile, true) )
      {
        return false;
      }

      // Attribute type (class name).
      char attrType[serialize::ATTR_NAME_SIZE];
      //
#ifndef WIN32
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wstringop-truncation"
#endif
      strncpy(attrType, attrName.c_str(), serialize::ATTR_NAME_SIZE);
#ifndef WIN32
#pragma GCC diagnostic pop
#endif
      //
      if ( fwrite(attrType, 1, serialize::ATTR_NAME_SIZE, pFile) != serialize::ATTR_NAME_SIZE )
      {
        fclose(pFile);
        return false;
      }

      // Serialize the attribute.
      if ( !A->Serialize(pFile) )
      {
        progress.SendLogMessage( LogWarn(Normal) << "AAG attribute '%1' cannot be serialized."
                                                 << attrName );

        // Put zero size of the buffer.
        if ( !asiAlgo_Utils::Binary::WriteInt(0, pFile, true) )
        {
          return false;
        }
        //
        continue;
      }
    }
  }

  fclose(pFile);
  return true;
}

//-----------------------------------------------------------------------------

bool asiAlgo_AAG::Deserialize(const char*          pFilename,
                              Handle(asiAlgo_AAG)& /*aag*/,
                              ActAPI_ProgressEntry progress)
{
  FILE* pFile = OSD_OpenFile(pFilename, "rb");
  //
  if ( pFile == NULL )
  {
    progress.SendLogMessage(LogErr(Normal) << "Cannot open file for reading.");
    return false;
  }

  /* =============
   *  Header info.
   * ============= */

  // Read file header.
  char header[serialize::HEADER_SIZE];
  //
  if ( !fread(header, 1, serialize::HEADER_SIZE, pFile) )
  {
    progress.SendLogMessage(LogErr(Normal) << "Corrupted binary file.");
    return false;
  }

  // Read 4 bytes for the version number.
  char intbuff[4];
  if ( !fread(intbuff, 1, 4, pFile) )
  {
    progress.SendLogMessage(LogErr(Normal) << "Corrupted binary file.");
    return false;
  }
  //
  const auto version = (BinFormat) asiAlgo_Utils::Binary::ReadInt(intbuff);
  //
  progress.SendLogMessage(LogInfo(Normal) << "Version of the AAG binary file: V%1." << version);
  //
  if ( version != BinFormat_V1 )
  {
    progress.SendLogMessage(LogErr(Normal) << "Unsupported version of the AAG binary file: V%1." << version);
    return false;
  }

  /* ==================================
   *  Adjacency matrix (graph as such).
   * ================================== */

  // Read 4 bytes for the number of nodes.
  if ( !fread(intbuff, 1, 4, pFile) )
  {
    progress.SendLogMessage(LogErr(Normal) << "Corrupted binary file.");
    return false;
  }
  //
  const int N = asiAlgo_Utils::Binary::ReadInt(intbuff);
  //
  progress.SendLogMessage(LogInfo(Normal) << "AAG has %1 nodes." << N);

  // Read N times the rows of adjacency matrix.
  asiAlgo_AdjacencyMx mx;
  //
  for ( int n = 1; n <= N; ++n )
  {
    // `fid`
    int fid = 0;
    {
      if ( !fread(intbuff, 1, 4, pFile) )
      {
        progress.SendLogMessage(LogErr(Normal) << "Corrupted binary file: `fid`.");
        return false;
      }
      //
      fid = asiAlgo_Utils::Binary::ReadInt(intbuff);
    }

    // `num. adjacent`
    int numAdj = 0;
    {
      if ( !fread(intbuff, 1, 4, pFile) )
      {
        progress.SendLogMessage(LogErr(Normal) << "Corrupted binary file: `num. adjacent`.");
        return false;
      }
      //
      numAdj = asiAlgo_Utils::Binary::ReadInt(intbuff);
    }

    // Read `nids`
    asiAlgo_Feature nids;
    //
    for ( int k = 0; k < numAdj; ++k )
    {
      // `nid`
      int nid = 0;
      {
        if ( !fread(intbuff, 1, 4, pFile) )
        {
          progress.SendLogMessage(LogErr(Normal) << "Corrupted binary file: `nid`.");
          return false;
        }
        //
        nid = asiAlgo_Utils::Binary::ReadInt(intbuff);
      }
      //
      nids.Add(nid);
    }

    // Fill the adjacency matrix.
    mx.mx.Bind(fid, nids);
  }

  // Dump M.
  {
    std::stringstream __debBuff;
    mx.Dump(__debBuff);
    std::cout << "FAG (Face Adjacency Graph): \n" << __debBuff.str();
  }

  /* ==============================
   *  Serializable node attributes.
   * ============================== */

  // TODO

  /* =============================
   *  Serializable arc attributes.
   * ============================= */

  /*int numNodes = 0;
  in >> numNodes;*/
  return true;
}

//-----------------------------------------------------------------------------

Handle(asiAlgo_AAG) asiAlgo_AAG::Copy() const
{
  Handle(asiAlgo_AAG) copy = new asiAlgo_AAG;
  //
  copy->m_master            = this->m_master;
  copy->m_selected          = this->m_selected;
  copy->m_subShapes         = this->m_subShapes;
  copy->m_tSubShapes        = this->m_tSubShapes;
  copy->m_faces             = this->m_faces;
  copy->m_tFaces            = this->m_tFaces;
  copy->m_edges             = this->m_edges;
  copy->m_tEdges            = this->m_tEdges;
  copy->m_vertices          = this->m_vertices;
  copy->m_tVertices         = this->m_tVertices;
  copy->m_verticesEdges     = this->m_verticesEdges;
  copy->m_tVerticesEdges    = this->m_tVerticesEdges;
  copy->m_verticesFaces     = this->m_verticesFaces;
  copy->m_tVerticesFaces    = this->m_tVerticesFaces;
  copy->m_edgesFaces        = this->m_edgesFaces;
  copy->m_tEdgesFaces       = this->m_tEdgesFaces;
  copy->m_neighborsStack    = this->m_neighborsStack;
  copy->m_arcAttributes     = this->m_arcAttributes;
  copy->m_nodeAttributes    = this->m_nodeAttributes;
  copy->m_bAllowSmooth      = this->m_bAllowSmooth;
  copy->m_fSmoothAngularTol = this->m_fSmoothAngularTol;
  //
  return copy;
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::PushSubgraph()
{
  this->PushSubgraphX( asiAlgo_Feature() );
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::PushSubgraph(const asiAlgo_Feature& faces2Keep)
{
  asiAlgo_AdjacencyMx& currentMx = m_neighborsStack.back();

  // Gather all present face indices into a single map.
  asiAlgo_Feature allFaces;
  for ( asiAlgo_AdjacencyMx::t_mx::Iterator it(currentMx.mx); it.More(); it.Next() )
    allFaces.Add( it.Key() );

  // Prepare a collection of face indices to eliminate.
  asiAlgo_Feature face2Exclude;
  face2Exclude.Subtraction(allFaces, faces2Keep);

  // Erase faces.
  this->PushSubgraphX(face2Exclude);
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::PushSubgraphX(const t_topoId face2Exclude)
{
  asiAlgo_Feature faces2Exclude;
  faces2Exclude.Add(face2Exclude);

  // Erase face.
  this->PushSubgraphX(faces2Exclude);
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::PushSubgraphX(const asiAlgo_Feature& faces2Exclude)
{
  asiAlgo_AdjacencyMx& currentMx = m_neighborsStack.back();
  asiAlgo_AdjacencyMx subgraphMx(m_alloc);

  // Compose new adjacency matrix.
  for ( asiAlgo_AdjacencyMx::t_mx::Iterator it(currentMx.mx); it.More(); it.Next() )
  {
    const t_topoId fid = it.Key();
    //
    if ( faces2Exclude.Contains(fid) )
      continue;

    asiAlgo_Feature row{ it.Value() };
    row.Subtract(faces2Exclude);

    subgraphMx.mx.Bind(fid, row);
  }

  // Push sub-graph to stack.
  m_neighborsStack.push_back(subgraphMx);
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::PopSubgraph()
{
  m_neighborsStack.pop_back();
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::PopSubgraphs()
{
  while ( m_neighborsStack.size() != 1 )
    m_neighborsStack.pop_back();
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::AddVertexAdjacencyArcs(const asiAlgo_Feature& domain)
{
  const TopTools_IndexedDataMapOfShapeListOfShape&
    vertsFaces = this->RequestMapOfVerticesFaces();

  asiAlgo_AdjacencyMx::t_mx& mx = m_neighborsStack.back().mx;

  for ( int v = 1; v <= vertsFaces.Extent(); ++v )
  {
    const TopoDS_Shape&         V     = vertsFaces.FindKey(v);
    const TopTools_ListOfShape& faces = vertsFaces.FindFromKey(V);

    for ( TopTools_ListOfShape::Iterator fit1(faces); fit1.More(); fit1.Next() )
    {
      const int f1 = this->GetFaceId( TopoDS::Face( fit1.Value() ) );

      if ( !domain.IsEmpty() && !domain.Contains(f1) )
        continue;

      for ( TopTools_ListOfShape::Iterator fit2(faces); fit2.More(); fit2.Next() )
      {
        const int f2 = this->GetFaceId( TopoDS::Face( fit2.Value() ) );
        //
        if ( f1 == f2 )
          continue;

        if ( !domain.IsEmpty() && !domain.Contains(f2) )
          continue;

        t_arc arc(f1, f2);

        if ( this->HasArc(arc) )
          continue;

        asiAlgo_Feature* pRow = mx.ChangeSeek(f1);
        //
        if ( pRow )
        {
          pRow->Add(f2);

          // Create attribute.
          if ( !m_arcAttributes.IsBound(arc) )
          {
            Handle(asiAlgo_FeatureAttrAngle)
              attrAngle = new asiAlgo_FeatureAttrAngle(FeatureAngleType_NonManifold, 0.);
            //
            attrAngle->setAAG(this);
            //
            m_arcAttributes.Bind(arc, t_arc_attr_set(attrAngle) );
          }
        }
      }
    }
  }
}

//-----------------------------------------------------------------------------

const TopoDS_Shape& asiAlgo_AAG::GetMasterShape() const
{
  return m_master;
}

//-----------------------------------------------------------------------------

const TopoDS_Shape& asiAlgo_AAG::GetMasterCAD() const
{
  return m_master;
}

//-----------------------------------------------------------------------------

int asiAlgo_AAG::GetNumberOfNodes() const
{
  const asiAlgo_AdjacencyMx& neighborhood = this->GetNeighborhood();
  //
  return neighborhood.mx.Extent();
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::SetSelectedFaces(const TopTools_IndexedMapOfShape& selectedFaces)
{
  m_selected.Clear();

  // Save selected faces for future filtering.
  for ( t_topoId s = 1; s <= selectedFaces.Extent(); ++s )
    m_selected.Add( m_faces.FindIndex( selectedFaces.FindKey(s) ) );
}

//-----------------------------------------------------------------------------

const asiAlgo_Feature& asiAlgo_AAG::GetSelectedFaces() const
{
  return m_selected;
}

//-----------------------------------------------------------------------------

bool asiAlgo_AAG::HasFace(const t_topoId face_idx) const
{
  return (face_idx > 0) && ( face_idx <= m_faces.Extent() );
}

//-----------------------------------------------------------------------------

bool asiAlgo_AAG::HasFace(const TopoDS_Shape& face) const
{
  return m_faces.Contains(face);
}

//-----------------------------------------------------------------------------

const TopoDS_Face& asiAlgo_AAG::GetFace(const t_topoId face_idx) const
{
  return TopoDS::Face( m_faces.FindKey(face_idx) );
}

//-----------------------------------------------------------------------------

t_topoId asiAlgo_AAG::GetFaceId(const TopoDS_Shape& face) const
{
  return m_faces.FindIndex(face);
}

//-----------------------------------------------------------------------------

bool asiAlgo_AAG::HasNeighbors(const t_topoId face_idx) const
{
  return m_neighborsStack.back().mx.IsBound(face_idx);
}

//-----------------------------------------------------------------------------

const asiAlgo_Feature& asiAlgo_AAG::GetNeighbors(const t_topoId face_idx,
                                                 const bool     stackTail) const
{
  return stackTail ? m_neighborsStack.front().mx.Find(face_idx)
                   : m_neighborsStack.back().mx.Find(face_idx);
}

//-----------------------------------------------------------------------------

asiAlgo_Feature asiAlgo_AAG::GetNeighbors(const asiAlgo_Feature& fids,
                                          const bool             stackTail) const
{
  asiAlgo_Feature res;

  for ( asiAlgo_Feature::Iterator fit(fids); fit.More(); fit.Next() )
  {
    const int              fid  = fit.Key();
    const asiAlgo_Feature& nids = this->GetNeighbors(fid, stackTail);

    res.Unite(nids);
  }

  res.Subtract(fids); // Get rid of the seed faces themselves.

  return res;
}

//-----------------------------------------------------------------------------

asiAlgo_Feature
  asiAlgo_AAG::GetNeighborsThru(const t_topoId     face_idx,
                                const TopoDS_Edge& edge)
{
  asiAlgo_Feature result;

  // Get all neighbors of the face of interest
  const asiAlgo_Feature& neighbors = this->GetNeighbors(face_idx);

  // Traverse all neighborhood arcs to see if there are any containing
  // the edge of interest in the list of common edges
  for ( asiAlgo_Feature::Iterator nit(neighbors); nit.More(); nit.Next() )
  {
    const t_topoId neighbor_idx = nit.Key();

    // Get neighborhood attribute
    Handle(asiAlgo_FeatureAttrAdjacency)
      adjAttr = Handle(asiAlgo_FeatureAttrAdjacency)::DownCast( this->GetArcAttribute( t_arc(face_idx, neighbor_idx) ) );
    //
    if ( adjAttr.IsNull() )
      continue;

    // Check the collection of common edges
    const asiAlgo_Feature&
      commonEdgeIndices = adjAttr->GetEdgeIndices();
    //
    const t_topoId edgeIdx = this->RequestMapOfEdges().FindIndex(edge);
    //
    if ( commonEdgeIndices.Contains(edgeIdx) )
      result.Add(neighbor_idx);
  }

  return result;
}

//-----------------------------------------------------------------------------

asiAlgo_Feature
  asiAlgo_AAG::GetNeighborsThru(const t_topoId         face_idx,
                                const asiAlgo_Feature& edge_ids)
{
  asiAlgo_Feature result;

  // Get neighbor faces
  const asiAlgo_Feature& neighbor_ids = this->GetNeighbors(face_idx);
  //
  for ( asiAlgo_Feature::Iterator nit(neighbor_ids); nit.More(); nit.Next() )
  {
    const t_topoId neighbor_idx = nit.Key();

    // Check arc attribute
    Handle(asiAlgo_FeatureAttr) attr = this->GetArcAttribute( t_arc(face_idx, neighbor_idx) );
    //
    if ( !attr->IsKind( STANDARD_TYPE(asiAlgo_FeatureAttrAdjacency) ) )
      continue;

    // Convert to adjacency attribute
    Handle(asiAlgo_FeatureAttrAdjacency)
      adjAttr = Handle(asiAlgo_FeatureAttrAdjacency)::DownCast(attr);
    //
    const asiAlgo_Feature&
      commonEdgeIndices = adjAttr->GetEdgeIndices();

    // Take the index of each edge and check if this edge is of interest
    for ( asiAlgo_Feature::Iterator eit(commonEdgeIndices); eit.More(); eit.Next() )
    {
      const t_topoId eidx = eit.Key();
      //
      if ( edge_ids.Contains(eidx) )
      {
        result.Add(neighbor_idx);
        break;
      }
    }
  }

  return result;
}

//-----------------------------------------------------------------------------

asiAlgo_Feature
  asiAlgo_AAG::GetNeighborsThruX(const t_topoId         face_idx,
                                 const asiAlgo_Feature& xEdges)
{
  asiAlgo_Feature result;

  // Get all neighbors of the face of interest
  const asiAlgo_Feature& neighbors = this->GetNeighbors(face_idx);

  // Traverse all neighborhood arcs to see if there are any containing
  // the edge of interest in the list of common edges
  for ( asiAlgo_Feature::Iterator nit(neighbors); nit.More(); nit.Next() )
  {
    const t_topoId neighbor_idx = nit.Key();

    // Get neighborhood attribute
    Handle(asiAlgo_FeatureAttrAdjacency)
      adjAttr = Handle(asiAlgo_FeatureAttrAdjacency)::DownCast( this->GetArcAttribute( t_arc(face_idx, neighbor_idx) ) );
    //
    if ( adjAttr.IsNull() )
      continue;

    // Check the collection of common edges
    asiAlgo_Feature commonEdgeIndices = adjAttr->GetEdgeIndices();

    // Subtract the restricted edges
    commonEdgeIndices.Subtract(xEdges);

    // If any edges remain, the neighbor face is added to the result
    if ( !commonEdgeIndices.IsEmpty() )
      result.Add(neighbor_idx);
  }

  return result;
}

//-----------------------------------------------------------------------------

asiAlgo_Feature
  asiAlgo_AAG::GetNeighborsThruVerts(const t_topoId face_idx)
{
  asiAlgo_Feature res;

  const TopoDS_Face& face = this->GetFace(face_idx);

  const TopTools_IndexedDataMapOfShapeListOfShape&
    vertsFaces = this->RequestMapOfVerticesFaces();

  for ( TopExp_Explorer vexp(face, TopAbs_VERTEX); vexp.More(); vexp.Next() )
  {
    const TopoDS_Shape&         V     = vexp.Current();
    const TopTools_ListOfShape& faces = vertsFaces.FindFromKey(V);

    for ( TopTools_ListOfShape::Iterator fit(faces); fit.More(); fit.Next() )
    {
      const int nid = this->GetFaceId( TopoDS::Face( fit.Value() ) );
      //
      if ( nid == face_idx )
        continue;

      res.Add(nid);
    }
  }

  return res;
}

//-----------------------------------------------------------------------------

const asiAlgo_AdjacencyMx& asiAlgo_AAG::GetNeighborhood() const
{
  return m_neighborsStack.back();
}

//-----------------------------------------------------------------------------

const TopTools_IndexedMapOfShape& asiAlgo_AAG::GetMapOfFaces() const
{
  return m_faces;
}

//-----------------------------------------------------------------------------

const asiAlgo_IndexedMapOfTShape& asiAlgo_AAG::RequestTMapOfFaces()
{
  if ( m_tFaces.IsEmpty() )
    asiAlgo_Utils::MapTShapes(m_master, TopAbs_FACE, m_tFaces);

  return m_tFaces;
}

//-----------------------------------------------------------------------------

const TopTools_IndexedMapOfShape& asiAlgo_AAG::RequestMapOfEdges()
{
  if ( m_edges.IsEmpty() )
    TopExp::MapShapes(m_master, TopAbs_EDGE, m_edges);

  return m_edges;
}

//-----------------------------------------------------------------------------

const asiAlgo_IndexedMapOfTShape& asiAlgo_AAG::RequestTMapOfEdges()
{
  if ( m_tEdges.IsEmpty() )
    asiAlgo_Utils::MapTShapes(m_master, TopAbs_EDGE, m_tEdges);

  return m_tEdges;
}

//-----------------------------------------------------------------------------

const TopTools_IndexedMapOfShape& asiAlgo_AAG::RequestMapOfVertices()
{
  if ( m_vertices.IsEmpty() )
    TopExp::MapShapes(m_master, TopAbs_VERTEX, m_vertices);

  return m_vertices;
}

//-----------------------------------------------------------------------------

const asiAlgo_IndexedMapOfTShape& asiAlgo_AAG::RequestTMapOfVertices()
{
  if ( m_tVertices.IsEmpty() )
    asiAlgo_Utils::MapTShapes(m_master, TopAbs_VERTEX, m_tVertices);

  return m_tVertices;
}

//-----------------------------------------------------------------------------

const TopTools_IndexedMapOfShape& asiAlgo_AAG::RequestMapOfSubShapes()
{
  if ( m_subShapes.IsEmpty() )
    TopExp::MapShapes(m_master, m_subShapes);

  return m_subShapes;
}

//-----------------------------------------------------------------------------

const asiAlgo_IndexedMapOfTShape& asiAlgo_AAG::RequestTMapOfSubShapes()
{
  if ( m_tSubShapes.IsEmpty() )
    asiAlgo_Utils::MapTShapes(m_master, m_tSubShapes);

  return m_tSubShapes;
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::RequestMapOf(const TopAbs_ShapeEnum      ssType,
                               TopTools_IndexedMapOfShape& map)
{
  switch ( ssType )
  {
    case TopAbs_VERTEX:
      map = this->RequestMapOfVertices();
      break;
    case TopAbs_EDGE:
      map = this->RequestMapOfEdges();
      break;
    case TopAbs_FACE:
      map = this->GetMapOfFaces();
      break;
    default: break;
  }
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::RequestTMapOf(const TopAbs_ShapeEnum      ssType,
                                asiAlgo_IndexedMapOfTShape& map)
{
  switch ( ssType )
  {
    case TopAbs_VERTEX:
      map = this->RequestTMapOfVertices();
      break;
    case TopAbs_EDGE:
      map = this->RequestTMapOfEdges();
      break;
    case TopAbs_FACE:
      map = this->RequestTMapOfFaces();
      break;
    default: break;
  }
}

//-----------------------------------------------------------------------------

const TopTools_IndexedDataMapOfShapeListOfShape&
  asiAlgo_AAG::RequestMapOfVerticesEdges()
{
  if ( m_verticesEdges.IsEmpty() )
    TopExp::MapShapesAndUniqueAncestors(m_master, TopAbs_VERTEX, TopAbs_EDGE, m_verticesEdges);

  return m_verticesEdges;
}

//-----------------------------------------------------------------------------

const asiAlgo_IndexedDataMapOfTShapeListOfShape&
  asiAlgo_AAG::RequestTMapOfVerticesEdges()
{
  if ( m_tVerticesEdges.IsEmpty() )
    asiAlgo_Utils::MapTShapesAndAncestors(m_master, TopAbs_VERTEX, TopAbs_EDGE, m_tVerticesEdges);

  return m_tVerticesEdges;
}

//-----------------------------------------------------------------------------

const TopTools_IndexedDataMapOfShapeListOfShape&
  asiAlgo_AAG::RequestMapOfVerticesFaces()
{
  if ( m_verticesFaces.IsEmpty() )
    TopExp::MapShapesAndAncestors(m_master, TopAbs_VERTEX, TopAbs_FACE, m_verticesFaces);

  return m_verticesFaces;
}

//-----------------------------------------------------------------------------

const asiAlgo_IndexedDataMapOfTShapeListOfShape&
  asiAlgo_AAG::RequestTMapOfVerticesFaces()
{
  if ( m_tVerticesFaces.IsEmpty() )
    asiAlgo_Utils::MapTShapesAndAncestors(m_master, TopAbs_VERTEX, TopAbs_FACE, m_tVerticesFaces);

  return m_tVerticesFaces;
}
//-----------------------------------------------------------------------------

const TopTools_IndexedDataMapOfShapeListOfShape&
  asiAlgo_AAG::RequestMapOfEdgesFaces()
{
  if ( m_edgesFaces.IsEmpty() )
    TopExp::MapShapesAndAncestors(m_master, TopAbs_EDGE, TopAbs_FACE, m_edgesFaces);

  return m_edgesFaces;
}

//-----------------------------------------------------------------------------

const asiAlgo_IndexedDataMapOfTShapeListOfShape&
  asiAlgo_AAG::RequestTMapOfEdgesFaces()
{
  if ( m_tEdgesFaces.IsEmpty() )
    asiAlgo_Utils::MapTShapesAndAncestors(m_master, TopAbs_EDGE, TopAbs_FACE, m_tEdgesFaces);

  return m_tEdgesFaces;
}

//-----------------------------------------------------------------------------

TopoDS_Shape asiAlgo_AAG::FindSubShapeByAddr(const std::string& addr)
{
  // Get all subshapes.
  const TopTools_IndexedMapOfShape& subShapes = this->RequestMapOfSubShapes();

  // Loop to find the one with the requested address.
  for ( TopTools_IndexedMapOfShape::Iterator ssit(subShapes); ssit.More(); ssit.Next() )
  {
    const TopoDS_Shape& current = ssit.Value();

    // Compare.
    std::string currentAddr = asiAlgo_Utils::ShapeAddr(current);
    //
    if ( currentAddr == addr )
      return current;
  }

  return TopoDS_Shape();
}

//-----------------------------------------------------------------------------

bool asiAlgo_AAG::HasArc(const t_arc& arc) const
{
  const asiAlgo_AdjacencyMx& mx = m_neighborsStack.back();

  // Seek for adjacency record.
  const asiAlgo_Feature* pRow = mx.mx.Seek(arc.F1);
  //
  if ( !pRow ) return false;

  return pRow->Contains(arc.F2);
}

//-----------------------------------------------------------------------------

bool asiAlgo_AAG::HasArcAttributes(const t_arc& arc) const
{
  return m_arcAttributes.IsBound(arc);
}

//-----------------------------------------------------------------------------

bool asiAlgo_AAG::HasArcAttribute(const t_arc&                 arc,
                                  Handle(asiAlgo_FeatureAttr)& attrAdj) const
{
  if ( !this->HasArcAttributes(arc) )
    return false;

  attrAdj = this->GetArcAttribute(arc);
  return true;
}

//-----------------------------------------------------------------------------

const asiAlgo_AAG::t_arc_attributes&
  asiAlgo_AAG::GetArcAttributes() const
{
  return m_arcAttributes;
}

//-----------------------------------------------------------------------------

Handle(asiAlgo_FeatureAttr)
  asiAlgo_AAG::GetArcAttribute(const t_arc& arc) const
{
  const t_arc_attr_set* attrSetPtr = m_arcAttributes.Seek(arc);
  if ( attrSetPtr == nullptr )
    return nullptr;

  return attrSetPtr->AngleAttr;
}

//-----------------------------------------------------------------------------

Handle(asiAlgo_FeatureAttr)
  asiAlgo_AAG::GetArcAttribute(const t_arc&         arc,
                               const Standard_GUID& attr_id) const
{
  const t_arc_attr_set* attrSetPtr = m_arcAttributes.Seek(arc);
  if ( attrSetPtr == nullptr )
    return nullptr;

  if ( attr_id == asiAlgo_FeatureAttrAngle::GUID() )
    return attrSetPtr->AngleAttr;

  const Handle(asiAlgo_FeatureAttr)* attrPtr = (*attrSetPtr).Seek(attr_id);
  if ( attrPtr == nullptr )
    return nullptr;

  return (*attrPtr);
}

//-----------------------------------------------------------------------------

bool asiAlgo_AAG::SetArcAttribute(const t_arc&                       arc,
                                  const Handle(asiAlgo_FeatureAttr)& attr)
{
  if ( attr.IsNull() )
    return false;

  Handle(asiAlgo_FeatureAttr) existing = this->GetArcAttribute( arc, attr->GetGUID() );
  //
  if ( !existing.IsNull() )
    return false; // Already there

  // Set owner AAG.
  attr->setAAG(this);

  // Add attribute to the set.
  t_attr_set* attrSetPtr = m_arcAttributes.ChangeSeek(arc);
  if ( attrSetPtr == nullptr )
    m_arcAttributes.Bind( arc, t_arc_attr_set(attr) );
  else
    (*attrSetPtr).Add(attr);

  return true;
}

//-----------------------------------------------------------------------------

bool asiAlgo_AAG::HasNodeAttributes(const t_topoId node) const
{
  return m_nodeAttributes.IsBound(node);
}

//-----------------------------------------------------------------------------

const asiAlgo_AAG::t_node_attributes& asiAlgo_AAG::GetNodeAttributes() const
{
  return m_nodeAttributes;
}

//-----------------------------------------------------------------------------

const asiAlgo_AAG::t_attr_set&
  asiAlgo_AAG::GetNodeAttributes(const t_topoId node) const
{
  return m_nodeAttributes(node);
}

//-----------------------------------------------------------------------------

Handle(asiAlgo_FeatureAttr)
  asiAlgo_AAG::GetNodeAttribute(const t_topoId       node,
                                const Standard_GUID& attr_id) const
{
  const t_attr_set* attrSetPtr = m_nodeAttributes.Seek(node);
  if ( attrSetPtr == nullptr )
    return nullptr;

  const Handle(asiAlgo_FeatureAttr)* attrPtr = (*attrSetPtr).Seek(attr_id);
  if ( attrPtr == nullptr )
    return nullptr;

  return (*attrPtr);
}

//-----------------------------------------------------------------------------

bool asiAlgo_AAG::RemoveNodeAttribute(const t_topoId       node,
                                      const Standard_GUID& attr_id)
{
  t_attr_set* attrSetPtr = m_nodeAttributes.ChangeSeek(node);
  if ( attrSetPtr == nullptr )
    return false;

  const Handle(asiAlgo_FeatureAttr)* attrPtr = (*attrSetPtr).Seek(attr_id);
  if ( attrPtr == nullptr )
    return false;

  return (*attrSetPtr).ChangeMap().UnBind(attr_id);
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::RemoveNodeAttributes()
{
  t_node_attributes newNodeAttrs;

  // Make sure that feature angle attributes created at AAG construction
  // time resist clean up. For that, we do not just clear the contents of
  // the AAG, but assemble a new AAG with the attributes that have to
  // remain.
  for ( t_node_attributes::Iterator it(m_nodeAttributes); it.More(); it.Next() )
  {
    const t_topoId    nid   = it.Key();
    const t_attr_set& attrs = it.Value();
    t_attr_set        newAttrs;
    //
    for ( t_attr_set::Iterator ait(attrs); ait.More(); ait.Next() )
    {
      if ( ait.GetGUID() == asiAlgo_FeatureAttrAngle::GUID() )
        newAttrs.Add( ait.GetAttr() );
    }

    if ( !newAttrs.GetMap().IsEmpty() )
      newNodeAttrs.Bind(nid, newAttrs);
  }

  m_nodeAttributes = newNodeAttrs;
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::RemoveNodeAttributes(const NCollection_Map<Standard_GUID, Standard_GUID>& keep)
{
  for ( t_node_attributes::Iterator it(m_nodeAttributes); it.More(); it.Next() )
  {
    const t_topoId    fid   = it.Key();
    const t_attr_set& attrs = it.Value();

    // Collect the attributes to remove. We cannot unbind attributes right
    // in the following loop as such modification would mess up the
    // iterator (crashes on Linux while pretends to be Ok on Windows).
    std::vector<Standard_GUID> toRemove;
    //
    for ( asiAlgo_AAG::t_attr_set::Iterator ait(attrs); ait.More(); ait.Next() )
    {
      const Handle(asiAlgo_FeatureAttr)& A = ait.GetAttr();
      //
      if ( A.IsNull() )
        continue;

      // Protected attribute.
      if ( ait.GetGUID() == asiAlgo_FeatureAttrAngle::GUID() )
        continue;

      const Standard_GUID& nextGuid = ait.GetGUID();
      //
      if ( !keep.Contains(nextGuid) )
      {
        toRemove.push_back(nextGuid);
      }
    }

    // Remove the attributes having the GUIDs marked for removal.
    for ( const auto& guid : toRemove )
    {
      this->RemoveNodeAttribute(fid, guid);
    }
  }
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::SetNodeAttributes(const t_node_attributes& attrs)
{
  m_nodeAttributes = attrs;
}

//-----------------------------------------------------------------------------

bool asiAlgo_AAG::SetNodeAttribute(const t_topoId                     node,
                                   const Handle(asiAlgo_FeatureAttr)& attr)
{
  if ( attr.IsNull() )
    return false;

  Handle(asiAlgo_FeatureAttr) existing = this->GetNodeAttribute( node, attr->GetGUID() );
  //
  if ( !existing.IsNull() )
    return false; // Already there

  // Set owner AAG
  attr->setAAG(this);

  // Set face ID to the attribute representing a feature face
  if ( attr->IsKind( STANDARD_TYPE(asiAlgo_FeatureAttrFace) ) )
    Handle(asiAlgo_FeatureAttrFace)::DownCast(attr)->SetFaceId(node);

  t_attr_set* attrSetPtr = m_nodeAttributes.ChangeSeek(node);
  if ( attrSetPtr == nullptr )
    m_nodeAttributes.Bind( node, t_attr_set(attr) );
  else
    (*attrSetPtr).Add(attr);

  return true;
}

//-----------------------------------------------------------------------------

bool asiAlgo_AAG::FindBaseOnly(asiAlgo_Feature& resultFaceIds) const
{
  for ( asiAlgo_AdjacencyMx::t_mx::Iterator it( m_neighborsStack.back().mx );
        it.More(); it.Next() )
  {
    const t_topoId fid = it.Key();

    // Get face to check the number of wires.
    const TopoDS_Face& face = this->GetFace(fid);

    // Get the number of wires.
    TopTools_IndexedMapOfShape wires;
    TopExp::MapShapes(face, TopAbs_WIRE, wires);
    //
    const int numWires = wires.Extent();

    if ( numWires > 1 )
      resultFaceIds.Add(fid);
  }

  return resultFaceIds.Extent() > 0;
}

//-----------------------------------------------------------------------------

bool asiAlgo_AAG::FindConvexOnly(asiAlgo_Feature& resultFaceIds) const
{
  asiAlgo_Feature traversed;
  for ( asiAlgo_AdjacencyMx::t_mx::Iterator it( m_neighborsStack.back().mx );
        it.More(); it.Next() )
  {
    const t_topoId         current_face_idx       = it.Key();
    const asiAlgo_Feature& current_face_neighbors = it.Value();

    // Mark face as traversed.
    if ( !traversed.Contains(current_face_idx) )
      traversed.Add(current_face_idx);
    else
      continue;

    // Loop over the neighbors.
    bool isAllConvex = true;
    for ( asiAlgo_Feature::Iterator nit(current_face_neighbors); nit.More(); nit.Next() )
    {
      const t_topoId neighbor_face_idx = nit.Key();

      // Get angle attribute
      Handle(asiAlgo_FeatureAttrAngle)
        attr = Handle(asiAlgo_FeatureAttrAngle)::DownCast( this->GetArcAttribute( t_arc(current_face_idx,
                                                                                        neighbor_face_idx) ) );

      if ( attr->GetAngleType() != FeatureAngleType_Convex &&
           attr->GetAngleType() != FeatureAngleType_SmoothConvex )
      {
        isAllConvex = false;

        // Mark face as traversed as we don't want to check concave neighbors
        traversed.Add(neighbor_face_idx);
      }
    }

    if ( isAllConvex )
      resultFaceIds.Add(current_face_idx);
  }

  return resultFaceIds.Extent() > 0;
}

//-----------------------------------------------------------------------------

bool asiAlgo_AAG::FindConvexOnly(TopTools_IndexedMapOfShape& resultFaces) const
{
  asiAlgo_Feature resultFaceIds;
  //
  if ( !this->FindConvexOnly(resultFaceIds) )
    return false;

  for ( asiAlgo_Feature::Iterator fit(resultFaceIds); fit.More(); fit.Next() )
    resultFaces.Add( this->GetFace( fit.Key() ) );

  return true;
}

//-----------------------------------------------------------------------------

bool asiAlgo_AAG::FindConcaveOnly(asiAlgo_Feature& resultFaceIds) const
{
  asiAlgo_Feature traversed;
  for ( asiAlgo_AdjacencyMx::t_mx::Iterator it( m_neighborsStack.back().mx );
        it.More(); it.Next() )
  {
    const t_topoId         current_face_idx       = it.Key();
    const asiAlgo_Feature& current_face_neighbors = it.Value();

    // Mark face as traversed
    if ( !traversed.Contains(current_face_idx) )
      traversed.Add(current_face_idx);
    else
      continue;

    // Loop over the neighbors
    bool isAllConcave = true;
    for ( asiAlgo_Feature::Iterator nit(current_face_neighbors); nit.More(); nit.Next() )
    {
      const t_topoId neighbor_face_idx = nit.Key();

      // Get angle attribute
      Handle(asiAlgo_FeatureAttrAngle)
        attr = Handle(asiAlgo_FeatureAttrAngle)::DownCast( this->GetArcAttribute( t_arc(current_face_idx,
                                                                                        neighbor_face_idx) ) );

      if ( attr->GetAngleType() != FeatureAngleType_Concave &&
           attr->GetAngleType() != FeatureAngleType_SmoothConcave )
      {
        isAllConcave = false;

        // Mark face as traversed as we don't want to check concave neighbors
        traversed.Add(neighbor_face_idx);
      }
    }

    if ( isAllConcave )
      resultFaceIds.Add(current_face_idx);
  }

  return resultFaceIds.Extent() > 0;
}

//-----------------------------------------------------------------------------

bool asiAlgo_AAG::FindConcaveOnly(TopTools_IndexedMapOfShape& resultFaces) const
{
  asiAlgo_Feature resultFaceIds;
  //
  if ( !this->FindConcaveOnly(resultFaceIds) )
    return false;

  for ( asiAlgo_Feature::Iterator fit(resultFaceIds); fit.More(); fit.Next() )
    resultFaces.Add( this->GetFace( fit.Key() ) );

  return true;
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::Remove(const TopTools_IndexedMapOfShape& faces)
{
  // NOTICE: indexed map of shapes is not affected as we want to keep
  //         using the original indices of faces

  // Find IDs of the faces to remove
  asiAlgo_Feature toRemove;
  for ( t_topoId f = 1; f <= faces.Extent(); ++f )
  {
    const t_topoId face_idx = this->GetFaceId( faces.FindKey(f) );
    toRemove.Add(face_idx);
  }

  // Remove by indices
  this->Remove(toRemove);
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::Remove(const asiAlgo_Feature& faceIndices)
{
  // NOTICE: indexed map of shapes is not affected as we want to keep
  //         using the original indices of faces

  // Loop over the target faces
  for ( asiAlgo_Feature::Iterator fit(faceIndices); fit.More(); fit.Next() )
  {
    const t_topoId face_idx = fit.Key();

    // Unbind node attributes
    m_nodeAttributes.UnBind(face_idx);

    // Find all neighbors
    const asiAlgo_Feature& neighbor_indices = m_neighborsStack.back().mx.Find(face_idx);
    for ( asiAlgo_Feature::Iterator nit(neighbor_indices); nit.More(); nit.Next() )
    {
      const t_topoId neighbor_idx = nit.Key();

      // Unbind arc attributes
      m_arcAttributes.UnBind( t_arc(face_idx, neighbor_idx) );

      // Kill the corresponding chunks from the list of neighbors
      asiAlgo_Feature* mapPtr = m_neighborsStack.back().mx.ChangeSeek(neighbor_idx);
      if ( mapPtr != nullptr )
        (*mapPtr).Subtract(faceIndices);
    }

    // Unbind node
    m_neighborsStack.back().mx.UnBind(face_idx);
  }
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::Collapse(const int fid)
{
  asiAlgo_Feature fids;
  fids.Add(fid);

  this->Collapse(fids);
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::Collapse(const asiAlgo_Feature& faceIndices)
{
  if ( faceIndices.IsEmpty() )
    return; // Nothing to collapse.

  asiAlgo_AdjacencyMx::t_mx& mx = m_neighborsStack.back().mx;

  /*
   * Collect all the links that should be restored upon eliminating
   * the target `fx` face from the graph. E.g. for the following
   * graph...
   *
   *              o f2
   *             /|\
   *            / | \
   *           /  |  \
   *       f1 o   |   o f3
   *           \  |  / \
   *            \ | /   \
   *             \|/     \
   *           fx o-------o f4
   *
   * ... we collect the following links:
   *
   * fx : (1, 2); (1, 3); (1, 4); (2, 3); (2, 4); (3, 4)
   * fy : ...
   *
   * Here is the collapsing result:
   *
   *              o f2
   *             /|\
   *            / | \
   *           /  |  \
   *       f1 o---+---o f3
   *           \  |  /
   *            \ | /
   *             \|/
   *           f4 o
   *
   * It is different from the node removal result, which looks as follows:
   *
   *              o f2
   *             / \
   *            /   \
   *           /     \
   *       f1 o       o f3
   *                   \
   *                    \
   *                     \
   *                      o f4
   */

  // Angle type and a Boolean flag to indicate if it's trustworthy.
  struct t_ang
  {
    asiAlgo_FeatureAngleType type;
    bool                     isDefinite;

    t_ang()                                          : type(FeatureAngleType_Undefined), isDefinite(false) {}
    t_ang(asiAlgo_FeatureAngleType _type, bool _def) : type(_type),                      isDefinite(_def) {}
  };

  typedef NCollection_DataMap<t_arc, t_ang, t_arc> t_arcsAngles;
  //
  t_arcsAngles allArcs; // Deduced angles for all processed arcs.
  //
  for ( asiAlgo_Feature::Iterator fit(faceIndices); fit.More(); fit.Next() )
  {
    const int fx = fit.Key();
    //
    if ( !mx.IsBound(fx) )
      continue;

    const asiAlgo_Feature& nids = mx.Find(fx);

    // Add all links.
    for ( asiAlgo_Feature::Iterator nit1(nids); nit1.More(); nit1.Next() )
    {
      const int nid1 = nit1.Key();

      // Skip other faces requested for collapse.
      if ( faceIndices.Contains(nid1) )
        continue;

      // Get dihedral angle for the 1-st neighbor.
      asiAlgo_FeatureAngleType fxn1Angle = ::GetAngleType(fx, nid1, this);

      for ( asiAlgo_Feature::Iterator nit2(nids); nit2.More(); nit2.Next() )
      {
        const int nid2 = nit2.Key();
        //
        if ( nid1 == nid2 )
          continue;

        // Skip other faces requested for collapse.
        if ( faceIndices.Contains(nid2) )
          continue;

        // Get dihedral angle for the 2-nd neighbor.
        asiAlgo_FeatureAngleType fxn2Angle = ::GetAngleType(fx, nid2, this);

        // Check for common angle.
        asiAlgo_FeatureAngleType cmnAngle = FeatureAngleType_Undefined;
        //
        if ( fxn1Angle == fxn2Angle )
        {
          cmnAngle = fxn1Angle; // Reuse the same angle.
        }
        else // Or deduce the new one.
        {
          if ( asiAlgo_FeatureAngle::IsConcave(fxn1Angle) && asiAlgo_FeatureAngle::IsConcave(fxn2Angle) )
          {
            cmnAngle = FeatureAngleType_Concave;
          }
          else if ( asiAlgo_FeatureAngle::IsConvex(fxn1Angle) && asiAlgo_FeatureAngle::IsConvex(fxn2Angle) )
          {
            cmnAngle = FeatureAngleType_Convex;
          }
          else if ( (fxn1Angle == FeatureAngleType_Smooth) && (fxn2Angle == FeatureAngleType_Smooth) )
          {
            cmnAngle = FeatureAngleType_Smooth;
          }
          else
          {
            // If one of the angles is non-manifold, we take the one which is defined.
            if ( (fxn1Angle == FeatureAngleType_NonManifold) && (fxn2Angle != FeatureAngleType_NonManifold) )
              cmnAngle = fxn2Angle;
            else if ( (fxn2Angle == FeatureAngleType_NonManifold) && (fxn1Angle != FeatureAngleType_NonManifold) )
              cmnAngle = fxn1Angle;
          }
        }

        const bool isAngDefinite = asiAlgo_FeatureAngle::IsDefinite(fxn1Angle) &&
                                   asiAlgo_FeatureAngle::IsDefinite(fxn2Angle);

        t_arc arc(nid1, nid2);

        // Check if the dihedral angle for the current arc exists and, if yes, whether
        // it can be precised, so that we do not end up with the "undefined" type if
        // there's a better take on that angle. The ambiguity of the angle definition
        // can be induced by vertex-adjacency links.
        t_ang* pAngType = allArcs.ChangeSeek(arc);
        //
        if ( !pAngType )
        {
          allArcs.Bind( arc, t_ang(cmnAngle, isAngDefinite) );
        }
        else
        {
          if ( !pAngType->isDefinite && isAngDefinite )
          {
            pAngType->type       = cmnAngle;
            pAngType->isDefinite = true;
          }
        }
      }
    }

    /* Remove `fx` faces from the incidence matrix. */
    asiAlgo_Feature* mapPtr = nullptr;
    //
    for ( asiAlgo_Feature::Iterator nit(nids); nit.More(); nit.Next() )
    {
      const int nid = nit.Key();

      // Skip faces requested for collapse.
      if ( faceIndices.Contains(nid) )
        continue;

      // Kill the corresponding chunks from the list of neighbors.
      mapPtr = mx.ChangeSeek(nid);
      if ( mapPtr != nullptr )
        mapPtr->Remove(fx);
    }

    // Unbind `fx` node.
    mx.UnBind(fx);
  }

  /* Add incidence relations to restore. */
  for ( t_arcsAngles::Iterator it(allArcs); it.More(); it.Next() )
  {
    const t_arc&                   arc     = it.Key();
    const asiAlgo_FeatureAngleType angType = it.Value().type;

    // Add F2 to F1 incidence list.
    {
      asiAlgo_Feature* mapPtr = mx.ChangeSeek(arc.F1);
      if ( mapPtr != nullptr )
        mapPtr->Add(arc.F2);
    }

    // Add F1 to F2 incidence list.
    {
      asiAlgo_Feature* mapPtr = mx.ChangeSeek(arc.F2);
      if ( mapPtr != nullptr )
        mapPtr->Add(arc.F1);
    }

    // Create attribute. If there was already a link between F1 and F2, then
    // we do not override it, because the remaining link corresponds to the
    // common edge between two faces, which should still be Ok after collapse.
    Handle(asiAlgo_FeatureAttr) pArcAttr = this->GetArcAttribute(arc);
    //
    if ( !pArcAttr )
    {
      Handle(asiAlgo_FeatureAttr)
        attrAngle = new asiAlgo_FeatureAttrAngle(angType, 0.);
      //
      attrAngle->setAAG(this);
      //
      m_arcAttributes.Bind(arc, attrAngle);
    }
  }
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::GetAllFaces(asiAlgo_Feature& allFaces) const
{
  // Gather all present face indices into a single map.
  for ( asiAlgo_AdjacencyMx::t_mx::Iterator it( m_neighborsStack.back().mx );
        it.More(); it.Next() )
  {
    const t_topoId face = it.Key();
    //
    allFaces.Add(face);
  }
}

//-----------------------------------------------------------------------------

int asiAlgo_AAG::GetConnectedComponentsNb()
{
  std::vector<asiAlgo_Feature> ccomps;
  this->GetConnectedComponents(ccomps);

  return int( ccomps.size() );
}

//-----------------------------------------------------------------------------

int asiAlgo_AAG::GetConnectedComponentsNb(const asiAlgo_Feature& excluded)
{
  // Gather all non-exluded face indices into a single map.
  asiAlgo_Feature seeds;
  for ( asiAlgo_AdjacencyMx::t_mx::Iterator it( m_neighborsStack.back().mx );
        it.More(); it.Next() )
  {
    const t_topoId fid = it.Key();
    //
    if ( !excluded.Contains(fid) )
      seeds.Add(fid);
  }

  // Collect connected components.
  std::vector<asiAlgo_Feature> ccomps;
  asiAlgo_Feature              traversed;
  //
  Handle(asiAlgo_AAGSetIterator) seed_it = new asiAlgo_AAGSetIterator(this, seeds);
  //
  for ( ; seed_it->More() ; seed_it->Next() )
  {
    // Get seed face.
    const t_topoId seed_face_id = seed_it->GetFaceId();
    //
    if ( traversed.Contains(seed_face_id) )
      continue; // Skip checked nodes.

    traversed.Add(seed_face_id);
    ccomps.push_back( asiAlgo_Feature() );
    ccomps.back().Add(seed_face_id);

    // Width-first search excluding unwanted faces.
    asiAlgo_Feature seed_neighbor_ids = this->GetNeighbors(seed_face_id);
    seed_neighbor_ids.Subtract(excluded);
    //
    asiAlgo_Feature seed_neighbor_next_iter;

    do
    {
      seed_neighbor_next_iter.Clear();

      for ( asiAlgo_Feature::Iterator nit(seed_neighbor_ids); nit.More(); nit.Next() )
      {
        const t_topoId  seed_face_id_new       = nit.Key();
        asiAlgo_Feature seed_neighbor_ids_cand = this->GetNeighbors(seed_face_id_new);
        //
        seed_neighbor_ids_cand.Subtract(excluded);

        if ( !seeds.Contains(seed_face_id_new) )
          continue; // Skip

        traversed.Add(seed_face_id_new);

        // Set faces for the next iteration
        seed_neighbor_ids_cand.Subtract(traversed);
        seed_neighbor_ids_cand.Intersect(seeds);
        seed_neighbor_next_iter.Unite(seed_neighbor_ids_cand);
        ccomps.back().Add(seed_face_id_new);
      }

      seed_neighbor_ids = seed_neighbor_next_iter;
    }
    while ( seed_neighbor_ids.Extent() != 0 );
  }

  return (int) ccomps.size();
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::GetConnectedComponents(const asiAlgo_Feature&        seeds,
                                         std::vector<asiAlgo_Feature>& res)
{
  res.clear();

  Handle(asiAlgo_AAGSetIterator) seed_it = new asiAlgo_AAGSetIterator(this, seeds);
  asiAlgo_Feature traversed;

  for ( ; seed_it->More() ; seed_it->Next() )
  {
    // Get seed face
    const t_topoId seed_face_id = seed_it->GetFaceId();

    if ( traversed.Contains(seed_face_id) )
      continue; // Skip checked nodes

    traversed.Add(seed_face_id);
    res.push_back( asiAlgo_Feature() );
    res.back().Add(seed_face_id);

    // Width-first search
    asiAlgo_Feature seed_neighbor_ids = this->GetNeighbors(seed_face_id);
    asiAlgo_Feature seed_neighbor_next_iter;

    do
    {
      seed_neighbor_next_iter.Clear();

      for ( asiAlgo_Feature::Iterator nit(seed_neighbor_ids); nit.More(); nit.Next() )
      {
        const t_topoId  seed_face_id_new       = nit.Key();
        asiAlgo_Feature seed_neighbor_ids_cand = this->GetNeighbors(seed_face_id_new);

        if ( !seeds.Contains(seed_face_id_new) )
          continue; // Skip

        traversed.Add(seed_face_id_new);

        // Set faces for the next iteration
        seed_neighbor_ids_cand.Subtract(traversed);
        seed_neighbor_ids_cand.Intersect(seeds);
        seed_neighbor_next_iter.Unite(seed_neighbor_ids_cand);
        res.back().Add(seed_face_id_new);
      }

      seed_neighbor_ids = seed_neighbor_next_iter;
    }
    while ( seed_neighbor_ids.Extent() != 0 );
  }
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::ClearCache()
{
  m_faces.Clear();
  m_edges.Clear();
  m_vertices.Clear();
  m_subShapes.Clear();
  m_edgesFaces.Clear();
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::GetConnectedComponents(std::vector<asiAlgo_Feature>& res)
{
  // Gather all present face indices into a single map.
  asiAlgo_Feature allFaces;
  for ( asiAlgo_AdjacencyMx::t_mx::Iterator it( m_neighborsStack.back().mx );
        it.More(); it.Next() )
  {
    const t_topoId face = it.Key();
    //
    allFaces.Add(face);
  }

  // Collect connected components using all faces as seeds.
  this->GetConnectedComponents(allFaces, res);
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::GetConnectedComponents(NCollection_Vector<asiAlgo_Feature>& res)
{
  std::vector<asiAlgo_Feature> ccomps;
  //
  this->GetConnectedComponents(ccomps);

  // Repack from the standard vector to the OpenCascade's collection.
  for ( auto cit = ccomps.cbegin(); cit != ccomps.cend(); ++cit )
    res.Append(*cit);
}

//-----------------------------------------------------------------------------

bool asiAlgo_AAG::HasIncidentEdgeOfVexity(const TopoDS_Vertex&              V,
                                          const asiAlgo_FeatureAngleType    type,
                                          const TopTools_IndexedMapOfShape& edges2Exclude)
{
  const TopTools_IndexedDataMapOfShapeListOfShape& vertEdgesMap  = this->RequestMapOfVerticesEdges();
  const TopTools_IndexedDataMapOfShapeListOfShape& edgeFacesMap  = this->RequestMapOfEdgesFaces();
  const TopTools_ListOfShape&                      incidentEdges = vertEdgesMap.FindFromKey(V);
  //
  for ( TopTools_ListIteratorOfListOfShape iit(incidentEdges); iit.More(); iit.Next() )
  {
    const TopoDS_Edge& incidentEdge = TopoDS::Edge( iit.Value() );
    //
    if ( edges2Exclude.Contains(incidentEdge) )
      continue;

    // Get all faces owning this edge.
    const TopTools_ListOfShape& faces = edgeFacesMap.FindFromKey(incidentEdge);
    //
    if ( faces.Extent() != 2 )
      continue; // Skip non-manifold edges (should never be any).

    const TopoDS_Face& F1 = TopoDS::Face( faces.First() );
    const TopoDS_Face& F2 = TopoDS::Face( faces.Last() );
    //
    const int f1 = this->GetFaceId(F1);
    const int f2 = this->GetFaceId(F2);

    asiAlgo_AAG::t_arc arc(f1, f2);
    //
    Handle(asiAlgo_FeatureAttrAngle)
      DA = this->ATTR_ARC<asiAlgo_FeatureAttrAngle>(arc);
    //
    if ( DA.IsNull() )
      continue;

    // We are looking for an angle of a certain type.
    if ( DA->GetAngleType() == type )
    {
      return true;
    }
  }

  return false;
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::Dump(Standard_OStream& out) const
{
  out << "===================================================\n";
  out << "***AAG structure\n";
  out << "---------------------------------------------------\n";
  out << " Adjacency\n";
  out << "---------------------------------------------------\n";

  // Dump neighborhood
  for ( t_topoId f = 1; f <= m_faces.Extent(); ++f )
  {
    out << "\t" << f << " -> ";
    const asiAlgo_Feature& neighbors = this->GetNeighbors(f);
    //
    for ( asiAlgo_Feature::Iterator nit(neighbors); nit.More(); nit.Next() )
    {
      out << nit.Key() << " ";
    }
    out << "\n";
  }

  // Dump arc attributes
  out << "---------------------------------------------------\n";
  out << " Node attributes\n";
  out << "---------------------------------------------------\n";
  for ( t_topoId f = 1; f <= m_faces.Extent(); ++f )
  {
    if ( !this->HasNodeAttributes(f) )
      continue;

    const t_attrMap& attrs = this->GetNodeAttributes(f).GetMap();
    //
    if ( attrs.IsEmpty() )
      continue;

    out << "\t" << f << " ~ ";
    //
    for ( t_attrMap::Iterator ait(attrs); ait.More(); ait.Next() )
    {
      out << "[" << ait.Value()->DynamicType()->Name() << "]\n";
      out << ">>>\n";
      ait.Value()->Dump(out);
      out << "\n<<<\n";
    }
    out << "\n";
  }
  out << "===================================================\n";
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::DumpJSON(Standard_OStream& out,
                           const int         whitespaces) const
{
  std::string prefix(whitespaces, ' ');

  out << std::setprecision( std::numeric_limits<double>::max_digits10 );
  out << prefix << "{";
  out << "\n" << prefix << "  \"nodes\": {";
  //
  this->dumpNodesJSON(out, whitespaces);
  //
  out << "\n" << prefix << "  },"; // End 'nodes'.
  //
  out << "\n" << prefix << "  \"arcs\": [";
  //
  this->dumpArcsJSON(out, whitespaces);
  //
  out << "\n" << prefix << "  ]"; // End 'arcs'.
  out << "\n" << prefix << "}";
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::init(const TopoDS_Shape&               masterCAD,
                       const TopTools_IndexedMapOfShape& selectedFaces,
                       const bool                        allowSmooth,
                       const double                      smoothAngularTol,
                       const int                         cachedMaps)
{
  // Prepare allocator.
  m_alloc = new NCollection_IncAllocator;

  // Pass allocator to the dihedral angle checker.
  m_checkDihAngle = new asiAlgo_CheckDihedralAngle(m_alloc);

  // If we are dealing with an assembly, let's not cache edges per faces.
  // See `/inspection/recognize-cavities/A06.tcl`.
  TopTools_IndexedMapOfShape allSolids;
  TopExp::MapShapes(masterCAD, TopAbs_SOLID, allSolids);
  //
  if ( allSolids.Extent() > 1 )
    m_checkDihAngle->SetUseCache(false);

  // Set basic props.
  m_master            = masterCAD;
  m_bAllowSmooth      = allowSmooth;
  m_fSmoothAngularTol = smoothAngularTol;

  //---------------------------------------------------------------------------

  // Put main adjacency matrix to the stack of graph states.
  m_neighborsStack.push_back( asiAlgo_AdjacencyMx(m_alloc) );

  //---------------------------------------------------------------------------

  // Extract all sub-shapes with unique indices from the master CAD.
  if ( cachedMaps & CachedMap_SubShapes )
    TopExp::MapShapes(masterCAD, m_subShapes);

  // Extract all faces with unique indices from the master CAD.
  if ( cachedMaps & CachedMap_Faces )
    TopExp::MapShapes(masterCAD, TopAbs_FACE, m_faces);

  // Extract all edges with unique indices from the master CAD.
  if ( cachedMaps & CachedMap_Edges )
    TopExp::MapShapes(masterCAD, TopAbs_EDGE, m_edges);

  // Extract all vertices with unique indices from the master CAD.
  if ( cachedMaps & CachedMap_Vertices )
    TopExp::MapShapes(masterCAD, TopAbs_VERTEX, m_vertices);

  // Build child-parent map for edges and their faces.
  if ( cachedMaps & CachedMap_EdgesFaces )
    TopExp::MapShapesAndAncestors(masterCAD, TopAbs_EDGE, TopAbs_FACE, m_edgesFaces);

  ShapeAnalysis_Edge sae;

  // Fill adjacency map with empty buckets and provide all required
  // treatment for each individual face.
  for ( t_topoId f = 1; f <= m_faces.Extent(); ++f )
  {
    m_neighborsStack.back().mx.Bind( f, asiAlgo_Feature() );
    //
    const TopoDS_Face& face = TopoDS::Face( m_faces(f) );

    // Special treatment deserve those faces having seam edges. Such faces
    // get their own attributes.
    for ( TopExp_Explorer exp(face, TopAbs_EDGE); exp.More(); exp.Next() )
    {
      const TopoDS_Edge& edge = TopoDS::Edge( exp.Current() );
      //
      if ( sae.IsSeam(edge, face) )
      {
        TopTools_IndexedMapOfShape edges;

        // Notice that smooth transitions are not allowed here. This is because
        // the following treatment is designed for periodic faces, and we normally
        // have self-transition of quality C1 and better there.
        double angRad = 0.0;
        //
        const asiAlgo_FeatureAngleType
          angType = m_checkDihAngle->AngleBetweenFaces(face, face, false, 0.0, edges, angRad);

        // Bind attribute representing the type of dihedral angle. This is an
        // exceptional case as normally such attributes are bound to arcs.
        m_nodeAttributes.Bind( f, t_attr_set( new asiAlgo_FeatureAttrAngle(angType, angRad) ) );
      }
    }
  }

  //---------------------------------------------------------------------------

  TopTools_IndexedDataMapOfShapeListOfShape ChildParentMap;
  TopExp::MapShapesAndAncestors(masterCAD, TopAbs_EDGE, TopAbs_FACE, ChildParentMap);

  // Build adjacency graph
  for ( TopExp_Explorer exp(masterCAD, TopAbs_EDGE); exp.More(); exp.Next() )
  {
    const TopoDS_Edge&          commonEdge    = TopoDS::Edge( exp.Current() );
    const TopTools_ListOfShape& adjacentFaces = ChildParentMap.FindFromKey(commonEdge);
    //
    this->addMates(adjacentFaces);
  }

  // Set selected faces
  this->SetSelectedFaces(selectedFaces);
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::addMates(const TopTools_ListOfShape& mateFaces)
{
  // Now analyze the face pairs
  for ( TopTools_ListIteratorOfListOfShape lit(mateFaces); lit.More(); lit.Next() )
  {
    const t_topoId     face_idx   = m_faces.FindIndex( lit.Value() );
    asiAlgo_Feature&   face_links = m_neighborsStack.back().mx.ChangeFind(face_idx);
    const TopoDS_Face& face       = TopoDS::Face( m_faces.FindKey(face_idx) );

    // Add all the rest faces as neighbors.
    for ( TopTools_ListIteratorOfListOfShape lit2(mateFaces); lit2.More(); lit2.Next() )
    {
      const t_topoId linked_face_idx = m_faces.FindIndex( lit2.Value() );

      if ( linked_face_idx == face_idx )
        continue; // Skip the same index to avoid loop arcs in the graph.

      if ( face_links.Contains(linked_face_idx) )
        continue;

      face_links.Add(linked_face_idx);

      // The graph is not oriented, so we do not want to compute arc
      // attribute G-F is previously we have already done F-G attribution.
      t_arc arc(face_idx, linked_face_idx);
      if ( m_arcAttributes.IsBound(arc) )
        continue;

      //-----------------------------------------------------------------------
      // Associate attributes
      //-----------------------------------------------------------------------

      const TopoDS_Face& linked_face = TopoDS::Face( m_faces.FindKey(linked_face_idx) );
      //
      TopTools_IndexedMapOfShape commonEdges;

      // Here we let client code decide whether to allow smooth transitions
      // or not. Smooth transition normally requires additional processing
      // in order to classify feature angle as concave or convex.
      double angRad = 0.0;
      //
      const asiAlgo_FeatureAngleType
        angle = m_checkDihAngle->AngleBetweenFaces(face,
                                                   linked_face,
                                                   m_bAllowSmooth,
                                                   m_fSmoothAngularTol,
                                                   commonEdges,
                                                   angRad);

      // Convert transient edge pointers to a collection of indices
      asiAlgo_Feature commonEdgeIndices;
      //
      for ( t_topoId eidx = 1; eidx <= commonEdges.Extent(); ++eidx )
      {
        const t_topoId
          globalEdgeIdx = this->RequestMapOfEdges().FindIndex( commonEdges(eidx) );
        //
        commonEdgeIndices.Add(globalEdgeIdx);
      }

      // Create attribute
      Handle(asiAlgo_FeatureAttr)
        attrAngle = new asiAlgo_FeatureAttrAngle(angle, angRad, commonEdgeIndices);

      // Set owner
      attrAngle->setAAG(this);

      // Bind
      m_arcAttributes.Bind(arc, attrAngle);
    }
  }
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::dumpNodesJSON(Standard_OStream& out,
                                const int         whitespaces) const
{
  int nidx = 0;
  //
  for ( asiAlgo_AdjacencyMx::t_mx::Iterator nit( m_neighborsStack.back().mx );
        nit.More(); nit.Next(), ++nidx )
  {
    const t_topoId nodeId = nit.Key();
    //
    this->dumpNodeJSON(nodeId, nidx == 0, out, whitespaces);
  }
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::dumpNodeJSON(const t_topoId    node,
                               const bool        isFirst,
                               Standard_OStream& out,
                               const int         whitespaces) const
{
  std::string prefix(whitespaces, ' ');

  // One attribute which should always be dumped is the surface type.
  std::string
    surfName = asiAlgo_Utils::SurfaceName( BRep_Tool::Surface( this->GetFace(node) ) );

  if ( !isFirst )
    out << ",";
  //
  out << "\n" << prefix << "    \"" << node << "\": {";
  out << "\n" << prefix << "      \"surface\": \"" << surfName << "\"";
  //
  if ( this->HasNodeAttributes(node) )
  {
    out << ",\n" << prefix << "      \"attributes\": [";

    // Dump attributes.
    const t_attr_set& attrs = this->GetNodeAttributes(node);
    //
    int attridx = 0;
    //
    for ( t_attr_set::Iterator ait(attrs); ait.More(); ait.Next(), ++attridx )
    {
      if ( attridx != 0 )
        out << ",";

      ait.GetAttr()->DumpJSON(out, 8 + whitespaces);
    }

    out << "\n" << prefix << "      ]";
  }
  //
  out << "\n" << prefix << "    }";
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::dumpArcsJSON(Standard_OStream& out,
                               const int         whitespaces) const
{
  // Map to filter out the already visited arcs.
  NCollection_Map<t_arc, t_arc> visited;

  int arcidx = 0;
  //
  for ( asiAlgo_AdjacencyMx::t_mx::Iterator it( m_neighborsStack.back().mx );
        it.More(); it.Next() )
  {
    const t_topoId f_idx = it.Key();

    // Get neighbors.
    const asiAlgo_Feature& localNeighbors = it.Value();

    // Dump arc for each neighbor.
    for ( asiAlgo_Feature::Iterator mit(localNeighbors); mit.More(); mit.Next(), ++arcidx )
    {
      const t_topoId neighbor_f_idx = mit.Key();

      // Check if the arc was not traversed before.
      t_arc arc(f_idx, neighbor_f_idx);
      //
      if ( visited.Contains(arc) )
        continue;
      //
      visited.Add(arc);

      // Dump arc.
      this->dumpArcJSON(arc, arcidx == 0, out, whitespaces);
    }
  }
}

//-----------------------------------------------------------------------------

void asiAlgo_AAG::dumpArcJSON(const t_arc&      arc,
                              const bool        isFirst,
                              Standard_OStream& out,
                              const int         whitespaces) const
{
  std::string prefix(whitespaces, ' ');

  Handle(asiAlgo_FeatureAttr) arcAttr = this->GetArcAttribute(arc);
  //
  Handle(asiAlgo_FeatureAttrAngle)
    arcAttrAngle = Handle(asiAlgo_FeatureAttrAngle)::DownCast(arcAttr);

  // Prepare a label for the angle type.
  std::string angleTypeStr;
  //
  if ( arcAttrAngle->GetAngleType() == FeatureAngleType_Convex )
    angleTypeStr = "convex";
  else if ( arcAttrAngle->GetAngleType() == FeatureAngleType_Concave )
    angleTypeStr = "concave";
  else if ( arcAttrAngle->GetAngleType() == FeatureAngleType_Smooth )
    angleTypeStr = "smooth";
  else if ( arcAttrAngle->GetAngleType() == FeatureAngleType_SmoothConcave )
    angleTypeStr = "smooth concave";
  else if ( arcAttrAngle->GetAngleType() == FeatureAngleType_SmoothConvex )
    angleTypeStr = "smooth convex";
  else if ( arcAttrAngle->GetAngleType() == FeatureAngleType_NonManifold )
    angleTypeStr = "non-manifold";
  else
    angleTypeStr = "undefined";

  // Prepare a label for the angle value (degrees).
  std::string angleDegStr = asiAlgo_Utils::Str::ToString<double>(arcAttrAngle->GetAngleRad() * 180. / M_PI);

  // Dump to the stream.
  if ( !isFirst )
    out << ",";
  //
  out << "\n" << prefix << "    [\"" << arc.F1 << "\", \""
                                     << arc.F2 << "\", \""
                                     << angleTypeStr << "\", "
                                     << angleDegStr << "]";
}
