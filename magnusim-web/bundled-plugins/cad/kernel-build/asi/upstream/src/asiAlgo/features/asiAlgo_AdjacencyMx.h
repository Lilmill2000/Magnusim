//-----------------------------------------------------------------------------
// Created on: 27 April 2020
//-----------------------------------------------------------------------------
// Copyright (c) 2020-present, Sergey Slyadnev
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

#ifndef asiAlgo_AdjacencyMx_h
#define asiAlgo_AdjacencyMx_h

// asiAlgo includes
#include <asiAlgo.h>

// OpenCascade includes
#include <NCollection_DataMap.hxx>
#include <NCollection_DoubleMap.hxx>
#include <TColStd_PackedMapOfInteger.hxx>

// Standard includes
#include <vector>

//-----------------------------------------------------------------------------

//! \ingroup ASI_AFR
//!
//! Adjacency matrix for all sorts of directed and undirected topology graphs,
//! such as face adjacency graphs (including AAG). In this matrix, we store
//! adjacency lists by rows:
//!
//! face 1 : <neighbor 1, neighbor 2, etc.>
//! face 2 : <neighbor 1, neighbor 2, etc.>
//! ...
class asiAlgo_AdjacencyMx
{
public:

  //! Type definition for the internal data structure.
  typedef NCollection_DataMap<t_topoId, TColStd_PackedMapOfInteger> t_mx;

  //! Standard collections-driven adjacency matrix.
  typedef std::vector< std::vector<int> > t_std_mx;

  //! Map of indices for graph labeling.
  typedef NCollection_DoubleMap<int, t_topoId> t_indexMap;

public:

  //! Default ctor.
  //! \param[in] alloc optional heap memory allocator.
  asiAlgo_AdjacencyMx(const Handle(NCollection_BaseAllocator)& alloc = nullptr) : mx(64, alloc)
  {}

  //! Assignment ctor.
  //! \param[in] _amx other adjacency matrix to copy into this one.
  asiAlgo_AdjacencyMx(const asiAlgo_AdjacencyMx& _amx)
  {
    this->mx = _amx.mx;
  }

public:

  //! Dumps this adjacency matrix to the passed output stream.
  asiAlgo_EXPORT void
    Dump(Standard_OStream& out) const;

public:

  t_mx mx; //!< Adjacency rows.

public:

  //! Converts the adjacency matrix to the standard C++ matrix.
  //! \param[out] idxMap the mapping between the original face IDs and their corresponding indices
  //!                    in the output standard C++ matrix.
  //! \return equivalent matrix driven by the standard C++ collections.
  asiAlgo_EXPORT t_std_mx
    AsStandard(t_indexMap& idxMap) const;
};

#endif
