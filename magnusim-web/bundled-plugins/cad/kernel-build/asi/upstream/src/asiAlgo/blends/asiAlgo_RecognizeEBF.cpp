//-----------------------------------------------------------------------------
// Created on: 01 October 2018
//-----------------------------------------------------------------------------
// Copyright (c) 2018-present, Sergey Slyadnev
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
#include <asiAlgo_RecognizeEBF.h>

// asiAlgo includes
#include <asiAlgo_AttrBlendCandidate.h>
#include <asiAlgo_AttrBlendSupport.h>
#include <asiAlgo_FeatureAttrAngle.h>
#include <asiAlgo_FindCrossEdges.h>
#include <asiAlgo_FindSmoothEdges.h>
#include <asiAlgo_FindSpringEdges.h>
#include <asiAlgo_FindTermEdges.h>

// OpenCascade includes
#include <BRepAdaptor_Surface.hxx>
#include <BRepGProp.hxx>
#include <BRepTools.hxx>
#include <gp_Cylinder.hxx>
#include <GProp_GProps.hxx>

#undef COUT_DEBUG
#if defined COUT_DEBUG
  #pragma message("===== warning: COUT_DEBUG is enabled")
#endif

#undef DRAW_DEBUG
#if defined DRAW_DEBUG
  #pragma message("===== warning: DRAW_DEBUG is enabled")
#endif

//-----------------------------------------------------------------------------

asiAlgo_RecognizeEBF::asiAlgo_RecognizeEBF(const Handle(asiAlgo_AAG)& aag,
                                           ActAPI_ProgressEntry       progress,
                                           ActAPI_PlotterEntry        plotter)
: ActAPI_IAlgorithm        (progress, plotter),
  m_aag                    (aag),
  m_pEdgeLengthMap         (nullptr),
  m_bAllowCones            (true),
  m_bAllowLinearExtrusions (false)
{}

//-----------------------------------------------------------------------------

void asiAlgo_RecognizeEBF::SetAllowCones(const bool on)
{
  m_bAllowCones = on;
}

//-----------------------------------------------------------------------------

void asiAlgo_RecognizeEBF::SetAllowLinearExtrusions(const bool on)
{
  m_bAllowLinearExtrusions = on;
}

//-----------------------------------------------------------------------------

void asiAlgo_RecognizeEBF::SetEdgeLengthsCache(std::unordered_map<int, double>* ptr)
{
  m_pEdgeLengthMap = ptr;
}

//-----------------------------------------------------------------------------

bool asiAlgo_RecognizeEBF::Perform(const int    fid,
                                   const double maxRadius)
{
  // Check AAG.
  if ( m_aag.IsNull() )
  {
    this->GetProgress().SendLogMessage(LogErr(Normal) << "AAG is null.");
    return false;
  }

  // Get face in question.
  const TopoDS_Face& face = m_aag->GetFace(fid);

  // Conical and planar types are normally left for chamfers...
  if ( asiAlgo_Utils::IsPlanar(face, false) )
    return false;
  //
  if ( !m_bAllowCones && asiAlgo_Utils::IsConical(face) ) // ... but we might wanna change that.
    return false;

  // Linear extrusions might be unwanted.
  if ( !m_bAllowLinearExtrusions &&
        asiAlgo_Utils::IsTypeOf<Geom_SurfaceOfLinearExtrusion>(face) )
    return false;

  // Prepare tool to find smooth edges.
  asiAlgo_FindSmoothEdges
    findSmoothEdges( m_aag,
                     this->GetProgress(),
                     this->GetPlotter() );

  // Prepare tool to find spring edges.
  asiAlgo_FindSpringEdges
    findSpringEdges( m_aag,
                     this->GetProgress(),
                     this->GetPlotter() );

  // Prepare tool to find cross edges.
  asiAlgo_FindCrossEdges
    findCrossEdges( m_aag,
                    this->GetProgress(),
                    this->GetPlotter() );

  // Prepare tool to find terminating edges.
  asiAlgo_FindTermEdges
    findTermEdges( m_aag,
                   this->GetProgress(),
                   this->GetPlotter() );

  /* =========================================================================
   *  STAGE 1: Identify smooth edges which is the first clue for recognition.
   * ========================================================================= */

  // Clean up the result.
  findSmoothEdges.ClearResult();

  // Detect smooth edges for a face.
  if ( !findSmoothEdges.PerformForFace(fid) )
  {
    this->GetProgress().SendLogMessage( LogErr(Normal) << "Cannot find smooth edges." );
    return false;
  }

  const TopTools_IndexedMapOfShape& smoothEdges       = findSmoothEdges.GetResultEdges();
  const TColStd_PackedMapOfInteger& smoothEdgeIndices = findSmoothEdges.GetResultIndices();
  //
  if ( smoothEdgeIndices.IsEmpty() )
    return false;

#if defined DRAW_DEBUG
  for ( int eidx = 1; eidx <= detect_smooth_edges.GetResultEdges().Extent(); ++eidx )
  {
    IV.DRAW_SHAPE( detect_smooth_edges.GetResultEdges()(eidx), Color_Blue );
  }
#endif

  /* =================================
   *  STAGE 2: Identify spring edges.
   * ================================= */

  // Clean up the result.
  findSpringEdges.ClearResult();

  // Detect spring edges.
  bool   isCandidateBlend;
  double candidateRadius;
  //
  if ( !findSpringEdges.PerformForFace(fid,
                                       smoothEdgeIndices,
                                       isCandidateBlend,
                                       candidateRadius) )
  {
    this->GetProgress().SendLogMessage( LogErr(Normal) << "Cannot find spring edges." );
    return false;
  }

  if ( !isCandidateBlend )
    return false;

  // Check if max radius is not exceeded.
  this->GetProgress().SendLogMessage( LogInfo(Normal) << "Detected candidate radius: %1."
                                                      << candidateRadius );
  //
  if ( candidateRadius > maxRadius )
    return false;

  const TopTools_IndexedMapOfShape& springEdges       = findSpringEdges.GetResultEdges();
  const TColStd_PackedMapOfInteger& springEdgeIndices = findSpringEdges.GetResultIndices();

  // Prepare face attribute.
  Handle(asiAlgo_AttrBlendCandidate)
    blendAttr = new asiAlgo_AttrBlendCandidate(0);
  //
  blendAttr->SetRadius(candidateRadius);
  //
  if ( !m_aag->SetNodeAttribute(fid, blendAttr) )
  {
    this->GetProgress().SendLogMessage( LogErr(Normal) << "Weird iteration: blend attribute is already there." );
    return false;
  }

  // Get number of spring edges and decide the blend type.
  bool      isUncertain  = false;
  const int nSpringEdges = springEdges.Extent();
  //
  if ( nSpringEdges == 2 )
  {
    blendAttr->Kind = BlendType_Ordinary;
  }
  else if ( nSpringEdges == 1)
  {
    blendAttr->Kind = BlendType_Cliff;
  }
  else
  {
    blendAttr->Kind = BlendType_Uncertain;

    // Initialize length as a fallback solution.
    blendAttr->Length = this->computeBlendLengthFallback(fid);
    isUncertain = true;
  }

  // Test vexity.
  blendAttr->Vexities.push_back( this->testVexity(fid) );

  if ( isUncertain )
    return false;

  this->GetPlotter().DRAW_SHAPE(face, Color_Blue, "Candidate blend after spring edge detection");
  //
  for ( int eidx = 1; eidx <= nSpringEdges; ++eidx )
  {
    this->GetPlotter().DRAW_SHAPE( springEdges(eidx), Color_Green, 1.0, true, "Spring_edge" );
  }

  // Populate blend candidate attribute with smooth and spring edges.
  blendAttr->SmoothEdgeIndices = smoothEdgeIndices;
  blendAttr->SpringEdgeIndices = springEdgeIndices;

  // Mark adjacent faces as support faces.
  for ( int ek = 1; ek <= springEdges.Extent(); ++ek )
  {
    const TopoDS_Edge& springEdge = TopoDS::Edge( springEdges(ek) );

    // Attribute support faces.
    TColStd_PackedMapOfInteger
      supportFaceIds = m_aag->GetNeighborsThru(fid, springEdge);
    //
    for ( TColStd_MapIteratorOfPackedMapOfInteger fit(supportFaceIds); fit.More(); fit.Next() )
    {
      const int supportFaceId = fit.Key();

      // Prepare face attribute.
      Handle(asiAlgo_AttrBlendSupport)
        blendSupportAttr = new asiAlgo_AttrBlendSupport(0);
      //
      m_aag->SetNodeAttribute(supportFaceId, blendSupportAttr);
    }
  }

  /* ================================
   *  STAGE 3: Identify cross edges.
   * ================================ */

  findCrossEdges.ClearResult();

  // Detect cross edges.
  if ( !findCrossEdges.PerformForFace(fid,
                                      smoothEdges,
                                      springEdges,
                                      candidateRadius) )
  {
    this->GetProgress().SendLogMessage( LogErr(Normal) << "Cannot find cross edges." );
    return false;
  }

  const TopTools_IndexedMapOfShape& crossEdges       = findCrossEdges.GetResultEdges();
  const TColStd_PackedMapOfInteger& crossEdgeIndices = findCrossEdges.GetResultIndices();

  // Get number of cross edges and precise the blend type.
  const int nCrossEdges = crossEdges.Extent();
  //
  if ( nCrossEdges == 1 || nCrossEdges == 2 )
  {
    blendAttr->Confirmed = true;

    // Get length of the cross edge.
    blendAttr->CrossLength = this->testLength( crossEdgeIndices.GetMinimalMapped() );
  }
  else if ( !nCrossEdges )
  {
    // Fallback solution for cross-lengths.
    blendAttr->CrossLength = this->computeCrossLength(fid);
  }

  for ( int eidx = 1; eidx <= nCrossEdges; ++eidx )
  {
    this->GetPlotter().DRAW_SHAPE( crossEdges(eidx), Color_Red, 1.0, true, "Cross_edge" );
  }

  // Populate blend candidate attribute with cross edges.
  blendAttr->CrossEdgeIndices = crossEdgeIndices;

  /* ======================================
   *  STAGE 4: Identify terminating edges.
   * ====================================== */

  findTermEdges.ClearResult();

  // Detect terminating edges.
  if ( !findTermEdges.PerformForFace(fid,
                                     smoothEdges,
                                     springEdges,
                                     crossEdges,
                                     candidateRadius) )
  {
    this->GetProgress().SendLogMessage( LogErr(Normal) << "Cannot find cross edges." );
    return false;
  }

  const TopTools_IndexedMapOfShape& terminatingEdges       = findTermEdges.GetResultEdges();
  const TColStd_PackedMapOfInteger& terminatingEdgeIndices = findTermEdges.GetResultIndices();

  // Get number of terminating edges to precise the blend type.
  const int nTerminatingEdges = terminatingEdges.Extent();
  //
  if ( nTerminatingEdges == 2 )
  {
    blendAttr->Confirmed = true;
  }

  for ( int eidx = 1; eidx <= nTerminatingEdges; ++eidx )
  {
    this->GetPlotter().DRAW_SHAPE( terminatingEdges(eidx), Color_Magenta, 1.0, true, "Terminating_edge" );
  }

  // Populate blend candidate attribute with terminating edges.
  blendAttr->TerminatingEdgeIndices = terminatingEdgeIndices;

  // Compute length of a EBF element based on the spring edges.
  blendAttr->Length = this->computeBlendLength(springEdgeIndices);

  return true;
}

//-----------------------------------------------------------------------------

double asiAlgo_RecognizeEBF::testLength(const int eid) const
{
  double len     = 0.;
  bool   compute = true;

  // Check cache.
  if ( m_pEdgeLengthMap )
  {
    auto cacheIt = m_pEdgeLengthMap->find(eid);
    //
    if ( cacheIt != m_pEdgeLengthMap->end() )
    {
      len     = cacheIt->second;
      compute = false;
    }
  }

  if ( compute )
  {
    GProp_GProps props;
    BRepGProp::LinearProperties(m_aag->RequestMapOfEdges()(eid), props);
    len = props.Mass();

    if ( m_pEdgeLengthMap ) m_pEdgeLengthMap->insert( {eid, len} );
  }

  return len;
}

//-----------------------------------------------------------------------------

double
  asiAlgo_RecognizeEBF::testLength(const TColStd_PackedMapOfInteger& eids) const
{
  double len = 0.;

  for ( TColStd_PackedMapOfInteger::Iterator eit(eids); eit.More(); eit.Next() )
  {
    len += this->testLength( eit.Key() );
  }

  return len;
}

//-----------------------------------------------------------------------------

double asiAlgo_RecognizeEBF::computeBlendLength(const TColStd_PackedMapOfInteger& eids) const
{
  return this->testLength(eids)*0.5;
}

//-----------------------------------------------------------------------------

double asiAlgo_RecognizeEBF::computeBlendLengthFallback(const int fid) const
{
  const TopoDS_Face& face = m_aag->GetFace(fid);

  // Currently supported are cylindrical faces only.
  double r, angMin, angMax, hMin, hMax;
  gp_Ax1 ax;
  //
  if ( !asiAlgo_Utils::IsCylindrical(face, r, ax, true, angMin, angMax, hMin, hMax) )
  {
    return 0.;
  }

  return Abs(hMax - hMin);
}

//-----------------------------------------------------------------------------

asiAlgo_BlendVexity
  asiAlgo_RecognizeEBF::testVexity(const int fid) const
{
  const TopoDS_Face& face = m_aag->GetFace(fid);

  /* Check 1: If all dihedral edges are concave, then EBF is also concave. */

  const asiAlgo_Feature& nids       = m_aag->GetNeighbors(fid);
  bool                   allConcave = true;
  //
  for ( asiAlgo_Feature::Iterator nit(nids); nit.More(); nit.Next() )
  {
    const int nid = nit.Key();

    asiAlgo_AAG::t_arc arc(fid, nid);

    // Get the dihedral angle.
    Handle(asiAlgo_FeatureAttrAngle)
      DA = m_aag->ATTR_ARC<asiAlgo_FeatureAttrAngle>(arc);
    //
    if ( DA.IsNull() )
      continue;

    const asiAlgo_FeatureAngleType vexity = DA->GetAngleType();

    if ( !asiAlgo_FeatureAngle::IsConcave(vexity) )
    {
      allConcave = false;
      break;
    }
  }
  //
  if ( allConcave )
    return BlendVexity_Concave;

  /* Check 2: Geometric tests */

  /* Toroidal surface */
  {
    Handle(Geom_ToroidalSurface) torusSurf;
    //
    if ( asiAlgo_Utils::IsTypeOf<Geom_ToroidalSurface>(face, torusSurf) )
    {
      const bool
        isInternal = ( face.Orientation() == TopAbs_REVERSED );

      return isInternal ? BlendVexity_Concave : BlendVexity_Convex;
    }
  }

  /* Cylinder */
  {
    gp_Cylinder cyl;
    //
    if ( asiAlgo_Utils::IsCylindrical(face, cyl) )
    {
      const bool
        isInternal = asiAlgo_Utils::IsInternal( face, 2*cyl.Radius(), cyl.Axis() );

      return isInternal ? BlendVexity_Concave : BlendVexity_Convex;
    }
  }

  return BlendVexity_Uncertain;
}

//-----------------------------------------------------------------------------

double asiAlgo_RecognizeEBF::computeCrossLength(const int fid) const
{
  const TopoDS_Face&  face = m_aag->GetFace(fid);
  BRepAdaptor_Surface bas(face);

  if ( bas.GetType() == GeomAbs_Cylinder )
  {
    // Take face domain
    double uMin, uMax, vMin, vMax;
    BRepTools::UVBounds(face, uMin, uMax, vMin, vMax);

    const double l = (uMax - uMin)*bas.Cylinder().Radius();
    return l;
  }

  return 0.;
}
