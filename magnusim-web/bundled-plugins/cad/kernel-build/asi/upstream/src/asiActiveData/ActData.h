//-----------------------------------------------------------------------------
// Created on: April 2012
//-----------------------------------------------------------------------------
// Copyright (c) 2017, OPEN CASCADE SAS
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
//    * Neither the name of OPEN CASCADE SAS nor the
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
//
// Web: http://analysissitus.org
//-----------------------------------------------------------------------------

#ifndef ActData_HeaderFile
#define ActData_HeaderFile

#ifdef _WIN32
# ifdef asiActiveData_EXPORTS
#  define ActData_EXPORT __declspec(dllexport)
# else
#  define ActData_EXPORT __declspec(dllimport)
# endif
#else
# define ActData_EXPORT
#endif

// Define BINARY format to be used for ACT Data persistence. Two formats
// are currently available:
// - BinOcaf -- standard OCCT format understanding any standard OCAF Attribute.
// - ACTBin -- extended standard OCCT format having BinOcaf functionality as a
//   subset and providing persistence (storage/retrieval) drivers for ACT
//   specific Attributes, e.g. Mesh Attribute. Notice that actually we use
//   extension points of TKBin library, not TKBinL (the latter is not
//   suitable for all ACT Parameters).
#define ACTBinFormat "ACTBin" // "ACTBin" or "BinOcaf"
#define ACTBinExt    "cbf"

// Macro to silent compiler warnings on unused function arguments
#define ActData_NotUsed(x)

#endif
