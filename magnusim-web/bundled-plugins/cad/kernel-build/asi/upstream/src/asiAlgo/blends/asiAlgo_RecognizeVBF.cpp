//-----------------------------------------------------------------------------
// Created on: 12 April (*) 2019
//-----------------------------------------------------------------------------
// Copyright (c) 2019-present, Sergey Slyadnev
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
#include <asiAlgo_RecognizeVBF.h>

// asiAlgo includes
#include <asiAlgo_AttrBlendCandidate.h>
#include <asiAlgo_AttrBlendSupport.h>
#include <asiAlgo_RecognizeCanonical.h>
#include <asiAlgo_FeatureAttrAdjacency.h>

// OpenCascade includes
#include <BRepGProp.hxx>
#include <BRepTools.hxx>
#include <Geom2d_BSplineCurve.hxx>
#include <Geom2dAdaptor_Curve.hxx>
#include <gp_Lin2d.hxx>
#include <GProp_GProps.hxx>

// Standard includes
#include <unordered_map>

//-----------------------------------------------------------------------------

asiAlgo_RecognizeVBF::asiAlgo_RecognizeVBF(const Handle(asiAlgo_AAG)& aag,
                                           ActAPI_ProgressEntry       progress,
                                           ActAPI_PlotterEntry        plotter)
: ActAPI_IAlgorithm (progress, plotter),
  m_aag             (aag)
{}

//-----------------------------------------------------------------------------

bool asiAlgo_RecognizeVBF::Perform(const int fid)
{
  // Check AAG.
  if ( m_aag.IsNull() )
  {
    this->GetProgress().SendLogMessage(LogErr(Normal) << "AAG is null.");
    return false;
  }

  // Get candidate face.
  const TopoDS_Face& face = m_aag->GetFace(fid);

  // Get face attribute which may already exist here if the VBF was
  // recognized as a EBF previously.
  Handle(asiAlgo_FeatureAttr)
    blendAttrBase = m_aag->GetNodeAttribute( fid, asiAlgo_AttrBlendCandidate::GUID() );
  //
  Handle(asiAlgo_AttrBlendCandidate)
    blendAttr = Handle(asiAlgo_AttrBlendCandidate)::DownCast(blendAttrBase);

  /* ----------------------------------------- */
  /* Heuristic 1: face is not of improper type */
  /* ----------------------------------------- */

  // Conical and planar types are left for chamfers.
  if ( asiAlgo_Utils::IsPlanar(face, false) || asiAlgo_Utils::IsConical(face) )
    return false;

  /* ------------------------------------------------- */
  /* Heuristic 2: the face is not a blend support face */
  /* ------------------------------------------------- */

  Handle(asiAlgo_FeatureAttr)
    supportAttrBase = m_aag->GetNodeAttribute( fid, asiAlgo_AttrBlendSupport::GUID() );
  //
  if ( !supportAttrBase.IsNull() )
    return false;

  /* -------------------------------------------------------- */
  /* Heuristic 3: all VBFs have not less than 3 adjacent EBFs */
  /* -------------------------------------------------------- */

  // Get the neighbor faces.
  const TColStd_PackedMapOfInteger& nids = m_aag->GetNeighbors(fid);

  // Structure to add additionally recognized cross-edges. Those edges
  // are collected when the heuristic is being checked, but not applied
  // directly to the AAG. The edges will be added later, once all heuristics
  // are done and the status of the vertex blend is confirmed.
  struct t_crossEdge
  {
    Handle(asiAlgo_AttrBlendCandidate) EBF;    //!< EBF to adjust.
    int                                edgeId; //!< New cross edge index.

    t_crossEdge() : edgeId(0) {}
    t_crossEdge(const Handle(asiAlgo_AttrBlendCandidate)& _ebf, const int _id) : EBF(_ebf), edgeId(_id) {}
  };
  //
  std::vector<t_crossEdge> extraCrossEdges;

  // The map to inherit radii from the neighboring EBFs.
  std::set<double> neighborsRadii;

  // Among the neighbor faces, there should be some EBFs. At least three
  // EBFs are expected.
  int numEBFs = 0;
  std::vector<asiAlgo_BlendVexity> ebfVexities;
  //
  for ( TColStd_MapIteratorOfPackedMapOfInteger nit(nids); nit.More(); nit.Next() )
  {
    const int nid = nit.Key();

    // Get neighbor face.
    const TopoDS_Face& neighborFace = m_aag->GetFace(nid);

    // Get blend candidate attribute.
    Handle(asiAlgo_FeatureAttr)
      neighborAttr = m_aag->GetNodeAttribute( nid, asiAlgo_AttrBlendCandidate::GUID() );
    //
    Handle(asiAlgo_AttrBlendCandidate)
      neighborBcAttr = Handle(asiAlgo_AttrBlendCandidate)::DownCast(neighborAttr);

    // EBFs are marked with blend candidate attributes.
    if ( neighborBcAttr.IsNull() )
      continue;

    if ( neighborBcAttr->Kind == BlendType_Vertex )
      return false; // A vertex blend cannot have another vertex blend as a neighbor.
                    // At least, we do not recognize such cases.

    /*
       Sometimes the adjacent EBF may have been recognized as a support face.
       The latter happens if the blend face was initially recognized as EBF
       itself. As this status of the blend face is going to be precised,
       its adjacent EBF should receive the new cross edge index which is the
       index of the edge shared with the blend face.
     */

    // Get ID of the common edge between the candidate vertex blend and the
    // neighbor EBF.
    TopoDS_Edge commonEdge = asiAlgo_Utils::GetCommonEdge(face, neighborFace);
    const int commonEdgeId = m_aag->RequestMapOfEdges().FindIndex(commonEdge);

    extraCrossEdges.push_back( t_crossEdge(neighborBcAttr, commonEdgeId) );

    // Increment the number of EBFs arriving at the candidate blend face to
    // check the heuristic.
    numEBFs++;

    // Keep track of EBF vexities.
    for ( const auto vexity : neighborBcAttr->Vexities )
      ebfVexities.push_back(vexity);

    // Update max radius.
    const double nr = neighborBcAttr->GetMaxRadius();
    //
    neighborsRadii.insert(nr);
  }
  //
  if ( numEBFs < 3 )
    return false;

  /* ---------------------------------------------------------------- */
  /* Heuristic 4: VBF cannot be adjacent to EBF via terminating edges */
  /* ---------------------------------------------------------------- */

  for ( TColStd_MapIteratorOfPackedMapOfInteger nit(nids); nit.More(); nit.Next() )
  {
    const int nid = nit.Key();

    // Get neighbor face.
    const TopoDS_Face& neighborFace = m_aag->GetFace(nid);

    // Get blend candidate attribute.
    Handle(asiAlgo_FeatureAttr)
      neighborAttr = m_aag->GetNodeAttribute( nid, asiAlgo_AttrBlendCandidate::GUID() );
    //
    Handle(asiAlgo_AttrBlendCandidate)
      neighborBcAttr = Handle(asiAlgo_AttrBlendCandidate)::DownCast(neighborAttr);

    // EBFs are marked with blend candidate attributes.
    if ( neighborBcAttr.IsNull() )
      continue;

    // Get ID of the common edge between the candidate vertex blend and the
    // neighbor EBF.
    TopoDS_Edge commonEdge = asiAlgo_Utils::GetCommonEdge(face, neighborFace);
    const int commonEdgeId = m_aag->RequestMapOfEdges().FindIndex(commonEdge);

    // Check if the common edge is terminating or not.
    if ( neighborBcAttr->TerminatingEdgeIndices.Contains(commonEdgeId) )
      return false;
  }

  /* ------------------------------------------------- */
  /*  Finalize recognition as all heuristics are done  */
  /* ------------------------------------------------- */

  // Add extra cross-edges.
  for ( size_t k = 0; k < extraCrossEdges.size(); ++k )
  {
    extraCrossEdges[k].EBF->CrossEdgeIndices.Add(extraCrossEdges[k].edgeId);
    extraCrossEdges[k].EBF->SpringEdgeIndices.Remove(extraCrossEdges[k].edgeId);
  }

  // If blend attribute is not available for this face, settle down a new one.
  if ( blendAttr.IsNull() )
  {
    blendAttr = new asiAlgo_AttrBlendCandidate(0);

    if ( !m_aag->SetNodeAttribute(fid, blendAttr) )
    {
      this->GetProgress().SendLogMessage( LogErr(Normal) << "Weird iteration: blend attribute is already there." );
      return false;
    }
  }
  else
  {
    // Clean up the edges.
    blendAttr->SmoothEdgeIndices.Clear();
    blendAttr->SpringEdgeIndices.Clear();
    blendAttr->CrossEdgeIndices.Clear();
  }

  // Store incident vexities.
  blendAttr->Vexities = ebfVexities;

  // Modify the attribute.
  if ( !this->treatSpecialCases(blendAttr) )
  {
    blendAttr->Radii  = neighborsRadii;
    blendAttr->Length = 0.; // Nullify as the length does not make sense for vertex blends.
  }
  //
  blendAttr->Kind = BlendType_Vertex;

  return true;
}

//-----------------------------------------------------------------------------

bool asiAlgo_RecognizeVBF::treatSpecialCases(const Handle(asiAlgo_AttrBlendCandidate)& attr)
{
  if ( this->treatToroidalCase(attr) )
    return true;

  // ... More special cases to add here

  return false;
}

//-----------------------------------------------------------------------------

bool asiAlgo_RecognizeVBF::treatToroidalCase(const Handle(asiAlgo_AttrBlendCandidate)& attr)
{
  if ( attr.IsNull() )
    return false;

  // Get the VBF face.
  const int          fid  = attr->GetFaceId();
  const TopoDS_Face& face = m_aag->GetFace(fid);

  // Special case of a toroidal surface.
  Handle(Geom_ToroidalSurface) surf;
  //
  if ( !asiAlgo_Utils::IsTypeOf<Geom_ToroidalSurface>(face, surf) )
    return false;

  // Compute UV bounds to derive the length.
  double uMin, uMax, vMin, vMax;
  BRepTools::UVBounds(face, uMin, uMax, vMin, vMax);

  // Lengths distributed by V levels. There can be several edges at both sides
  // of a vertex blend, so we have to accumulate their lengths separately
  // to compute average later on.
  std::unordered_map<double, double> lengths3d;

  // Get all edges of a VBF.
  TopTools_IndexedMapOfShape edgesMap;
  TopExp::MapShapes(face, TopAbs_EDGE, edgesMap);
  //
  for ( int k = 1; k <= edgesMap.Extent(); ++k )
  {
    const TopoDS_Edge& E = TopoDS::Edge( edgesMap(k) );

    // Get pcurve.
    double f, l;
    Handle(Geom2d_Curve) c2d = BRep_Tool::CurveOnSurface(E, face, f, l);
    //
    if ( c2d.IsNull() )
      continue;

    Geom2dAdaptor_Curve GAC(c2d, f, l);
    gp_Dir2d            DU(1, 0);
    GeomAbs_CurveType   c2dType = GAC.GetType();

    /* Check if pcurve line is parallel to OU axis. */

    gp_Lin2d lin;
    //
    if ( c2dType == GeomAbs_Line )
    {
      lin = GAC.Line();
    }
    else if ( c2dType == GeomAbs_BSplineCurve )
    {
      Handle(Geom2d_BSplineCurve) spl = GAC.BSpline();

      double dev = 0.;
      if ( !asiAlgo_RecognizeCanonical::IsLinear(spl->Poles(), Precision::Confusion(), dev, lin) )
        continue;
    }
    else
      continue; // Not a line.

    // Test if the line is aligned with OU axis.
    gp_Dir2d DL = lin.Direction();
    //
    if ( DL.IsParallel( DU, 1*M_PI/180. ) ) // 1 degree tolerance.
    {
      GProp_GProps props;
      BRepGProp::LinearProperties(E, props);
      const double edgeLen = props.Mass();

      const double v     = lin.Location().Y();
      auto         tuple = lengths3d.find(v);

      if ( tuple == lengths3d.end() )
      {
        lengths3d.insert( {v, edgeLen} );
      }
      else
      {
        tuple->second += edgeLen;
      }
    }
  }

  // Compute the average length.
  double vbfLen = 0.;
  //
  if ( !lengths3d.empty() )
  {
    for ( auto l : lengths3d )
    {
      vbfLen += l.second;
    }

    vbfLen /= int( lengths3d.size() );
  }

  // Set the length.
  attr->Length = vbfLen;

  // Use the minor radius.
  attr->Radii.clear();
  attr->Radii.insert( surf->MinorRadius() );
  return true;
}
